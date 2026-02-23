'use strict';

const config = require('../config');
const logger = require('../utils/logger');
const { withRetry, RateLimiter } = require('../utils/retry');

const rateLimiter = new RateLimiter(config.POLYMARKET_RATE_LIMIT_RPS);

// ─── HTTP helpers ────────────────────────────────────────────────────────────

async function fetchJson(url, label, opts = {}) {
  await rateLimiter.wait();

  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'polymarket-weather-bot/1.0',
      ...opts.headers,
    },
    method: opts.method || 'GET',
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${label}`);
    err.status = res.status;
    throw err;
  }

  return res.json();
}

// ─── Gamma API — Event discovery ─────────────────────────────────────────────

/**
 * Fetch a Polymarket event by slug.
 * Returns the event object (with embedded markets) or null if not found.
 */
async function fetchEventBySlug(slug) {
  const url = `${config.POLYMARKET_GAMMA_BASE}/events?slug=${encodeURIComponent(slug)}`;

  const data = await withRetry(
    () => fetchJson(url, `gamma:event:${slug}`),
    { label: `gamma:event:${slug}`, circuitKey: 'polymarket' },
  );

  if (!data || !Array.isArray(data) || data.length === 0) {
    return null;
  }

  return data[0];
}

/**
 * Fetch a single market by its numeric Gamma ID.
 * Used to get bestBid/bestAsk/volume for a single market when needed.
 */
async function fetchGammaMarket(marketId) {
  const url = `${config.POLYMARKET_GAMMA_BASE}/markets/${encodeURIComponent(marketId)}`;

  return withRetry(
    () => fetchJson(url, `gamma:market:${marketId}`),
    { label: `gamma:market:${marketId}`, circuitKey: 'polymarket' },
  );
}

// ─── CLOB API — Batch pricing ────────────────────────────────────────────────

/**
 * Fetch midpoint prices for multiple token IDs in a single request.
 * Midpoint = (bestBid + bestAsk) / 2, computed server-side.
 *
 * @param {string[]} tokenIds - Array of YES token IDs
 * @returns {Map<string, number>} Map of tokenId → midpoint (0-1)
 */
async function fetchMidpoints(tokenIds) {
  if (tokenIds.length === 0) return new Map();

  const url = `${config.POLYMARKET_CLOB_BASE}/midpoints?token_ids=${tokenIds.join(',')}`;

  const data = await withRetry(
    () => fetchJson(url, `clob:midpoints:${tokenIds.length}ids`),
    { label: `clob:midpoints:${tokenIds.length}ids`, circuitKey: 'polymarket' },
  );

  if (!data || typeof data !== 'object') return new Map();

  const result = new Map();
  for (const [tokenId, priceStr] of Object.entries(data)) {
    const price = parseFloat(priceStr);
    if (!isNaN(price)) {
      result.set(tokenId, price);
    }
  }
  return result;
}

/**
 * Fetch spreads for multiple token IDs in a single request.
 * Spread = bestAsk - bestBid, computed server-side.
 *
 * @param {string[]} tokenIds - Array of YES token IDs
 * @returns {Map<string, number>} Map of tokenId → spread (0-1)
 */
async function fetchSpreads(tokenIds) {
  if (tokenIds.length === 0) return new Map();

  const body = tokenIds.map(id => ({ token_id: id }));

  const data = await withRetry(
    () => fetchJson(`${config.POLYMARKET_CLOB_BASE}/spreads`, `clob:spreads:${tokenIds.length}ids`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    }),
    { label: `clob:spreads:${tokenIds.length}ids`, circuitKey: 'polymarket' },
  );

  if (!data || typeof data !== 'object') return new Map();

  const result = new Map();
  for (const [tokenId, spreadStr] of Object.entries(data)) {
    const spread = parseFloat(spreadStr);
    if (!isNaN(spread)) {
      result.set(tokenId, spread);
    }
  }
  return result;
}

/**
 * Fetch midpoints + spreads for an event's markets in 2 batch requests.
 * Returns array of { mid, spread } in the same order as input marketDims.
 *
 * @param {Array<{ token_id_yes: string }>} marketDims - market_dim rows with YES token IDs
 * @returns {Array<{ mid: number, spread: number }>} Prices in same order as input
 */
async function fetchEventPrices(marketDims) {
  const tokenIds = marketDims
    .map(m => m.token_id_yes)
    .filter(Boolean);

  if (tokenIds.length === 0) {
    return marketDims.map(() => ({ mid: 0, spread: 0 }));
  }

  // Batch fetch: 2 requests total per event
  const [mids, spreads] = await Promise.all([
    fetchMidpoints(tokenIds),
    fetchSpreads(tokenIds),
  ]);

  return marketDims.map(m => {
    const tokenId = m.token_id_yes;
    if (!tokenId) return { mid: 0, spread: 0 };
    return {
      mid: mids.get(tokenId) || 0,
      spread: spreads.get(tokenId) || 0,
    };
  });
}

// ─── Label parser ────────────────────────────────────────────────────────────

/**
 * Parse an outcome label into bin type and bounds.
 *
 * Known patterns from Polymarket temperature markets:
 *   "21°F or below"    → { binType: 'LE', binLow: null, binHigh: 21 }
 *   "22-23°F"          → { binType: 'RANGE', binLow: 22, binHigh: 23 }
 *   "36°F or higher"   → { binType: 'GE', binLow: 36, binHigh: null }
 *   "21°C or below"    → same pattern with °C
 *
 * @param {string} label
 * @returns {{ binType: string, binLow: number|null, binHigh: number|null }}
 */
function parseOutcomeLabel(label) {
  const s = label.trim();

  // "X°F or below" / "X°C or below"
  const leMatch = s.match(/^(-?\d+(?:\.\d+)?)\s*°[FC]\s+or\s+below$/i);
  if (leMatch) {
    return { binType: 'LE', binLow: null, binHigh: parseFloat(leMatch[1]) };
  }

  // "X°F or higher" / "X°C or higher"
  const geMatch = s.match(/^(-?\d+(?:\.\d+)?)\s*°[FC]\s+or\s+higher$/i);
  if (geMatch) {
    return { binType: 'GE', binLow: parseFloat(geMatch[1]), binHigh: null };
  }

  // "X-Y°F" / "X-Y°C" (range, handles negatives)
  const rangeMatch = s.match(/^(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)\s*°[FC]$/i);
  if (rangeMatch) {
    const low = parseFloat(rangeMatch[1]);
    const high = parseFloat(rangeMatch[2]);
    return { binType: 'RANGE', binLow: Math.min(low, high), binHigh: Math.max(low, high) };
  }

  // Exact "X°F" / "X°C"
  const eqMatch = s.match(/^(-?\d+(?:\.\d+)?)\s*°[FC]$/i);
  if (eqMatch) {
    return { binType: 'EQ', binLow: parseFloat(eqMatch[1]), binHigh: null };
  }

  logger.warn({ label }, 'Could not parse outcome label — storing as-is');
  return { binType: 'RANGE', binLow: null, binHigh: null };
}

/**
 * Extract markets from a Gamma API event response and return normalized array.
 * Sorted by bin_low (ascending), with LE bins first and GE bins last.
 */
function extractMarkets(event) {
  if (!event || !event.markets) return [];

  return event.markets
    .map((m) => {
      const parsed = parseOutcomeLabel(m.groupItemTitle || m.question || '');
      // clobTokenIds comes as a JSON string: '["tokenYes","tokenNo"]'
      let tokenIdYes = null;
      let tokenIdNo = null;
      if (m.clobTokenIds) {
        try {
          const ids = JSON.parse(m.clobTokenIds);
          tokenIdYes = ids[0] || null;
          tokenIdNo = ids[1] || null;
        } catch {
          logger.warn({ marketId: m.id, clobTokenIds: m.clobTokenIds }, 'Failed to parse clobTokenIds');
        }
      }
      return {
        marketId: m.id,
        conditionId: m.conditionId,
        questionId: m.questionID,
        label: m.groupItemTitle || m.question || '',
        ...parsed,
        tokenIdYes,
        tokenIdNo,
      };
    })
    .sort((a, b) => {
      const aKey = a.binType === 'LE' ? -Infinity : a.binType === 'GE' ? Infinity : (a.binLow ?? 0);
      const bKey = b.binType === 'LE' ? -Infinity : b.binType === 'GE' ? Infinity : (b.binLow ?? 0);
      return aKey - bKey;
    });
}

module.exports = {
  fetchEventBySlug,
  fetchGammaMarket,
  fetchMidpoints,
  fetchSpreads,
  fetchEventPrices,
  parseOutcomeLabel,
  extractMarkets,
};
