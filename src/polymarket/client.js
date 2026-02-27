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

// ─── Gamma API — Event pricing ───────────────────────────────────────────────
// Temperature markets are AMM-based (no CLOB orderbook).
// Prices come from the outcomePrices field in the Gamma API event response.

/**
 * Fetch current prices for all markets of an event via Gamma API.
 * Uses outcomePrices field which is always available for temperature markets.
 *
 * @param {string} polymarketEventId - Numeric event ID (e.g. "227475")
 * @param {Array<{ market_id: string, label: string }>} marketDims - market_dim rows in bin order
 * @returns {Array<{ mid: number, spread: number, yesPrice: number, noPrice: number, volume24h: number }>}
 */
async function fetchEventPricesFromGamma(polymarketEventId, marketDims) {
  if (!polymarketEventId) {
    return marketDims.map(() => ({ mid: 0, spread: 0, yesPrice: 0, noPrice: 0, volume24h: 0 }));
  }

  const url = `${config.POLYMARKET_GAMMA_BASE}/events/${encodeURIComponent(polymarketEventId)}`;

  const event = await withRetry(
    () => fetchJson(url, `gamma:event:prices:${polymarketEventId}`),
    { label: `gamma:event:prices:${polymarketEventId}`, circuitKey: 'polymarket' },
  );

  if (!event || !event.markets) {
    return marketDims.map(() => ({ mid: 0, spread: 0, yesPrice: 0, noPrice: 0, volume24h: 0 }));
  }

  // Build lookup by market_id for O(1) access
  const priceByMarketId = new Map();
  for (const m of event.markets) {
    try {
      const rawPrices = m.outcomePrices;
      const prices = typeof rawPrices === 'string' ? JSON.parse(rawPrices) : rawPrices;
      const yesPrice = parseFloat(prices?.[0] ?? '0') || 0;
      const noPrice = parseFloat(prices?.[1] ?? '0') || 0;
      const mid = yesPrice; // For AMM markets, outcomePrices[0] IS the price
      const spread = parseFloat(m.spread ?? '0') || 0;
      const volume24h = parseFloat(m.volume24hr ?? '0') || 0;

      priceByMarketId.set(String(m.id), { mid, spread, yesPrice, noPrice, volume24h });
    } catch (err) {
      logger.warn({ err: err.message, marketId: m.id }, 'Failed to parse outcomePrices');
    }
  }

  // Return in same order as marketDims (bin order)
  return marketDims.map(dim => {
    const price = priceByMarketId.get(String(dim.market_id));
    if (!price) {
      logger.debug({ marketId: dim.market_id, label: dim.label }, 'Market not found in Gamma response');
      return { mid: 0, spread: 0, yesPrice: 0, noPrice: 0, volume24h: 0 };
    }
    return price;
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
  fetchEventPricesFromGamma,
  parseOutcomeLabel,
  extractMarkets,
};
