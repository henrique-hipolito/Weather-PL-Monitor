'use strict';

const config = require('../config');
const db = require('../db');
const logger = require('../utils/logger');
const { targetDates } = require('../utils/timezone');
const { buildEventSlug } = require('./slugBuilder');
const { fetchEventBySlug, extractMarkets, fetchEventPrices } = require('./client');

/**
 * Run one cycle of market discovery for all cities.
 */
async function discoverMarkets() {
  const stats = { discovered: 0, existing: 0, notFound: 0, errors: 0 };

  for (const city of config.CITIES) {
    try {
      const dates = targetDates(city.timezone, config.DAYS_AHEAD);

      for (const { dateLocal, dt } of dates) {
        const slug = buildEventSlug(city.slug_name, dt);

        // Check if already registered
        const existing = await db.query(
          `SELECT event_id FROM events
           WHERE city_id = $1 AND event_date_local = $2 AND metric = 'TMAX'`,
          [city.city_id, dateLocal],
        );

        if (existing.rows.length > 0) {
          stats.existing++;
          continue;
        }

        // Try to fetch from Polymarket
        const event = await fetchEventBySlug(slug);
        if (!event) {
          logger.debug({ city: city.city_id, date: dateLocal, slug }, 'Event not found on Polymarket yet');
          stats.notFound++;
          continue;
        }

        // Register the event
        await registerEvent(city, dateLocal, slug, event);
        stats.discovered++;
        logger.info({ city: city.city_id, date: dateLocal, slug, pmEventId: event.id },
          'New event discovered and registered');
      }
    } catch (err) {
      stats.errors++;
      logger.error({ err: err.message, city: city.city_id }, 'Error during market discovery');
    }
  }

  logger.info({ ...stats }, 'Market discovery cycle complete');
  return stats;
}

/**
 * Register a new event + its market_dim rows + market_open_context.
 * All in a single transaction.
 */
async function registerEvent(city, dateLocal, slug, pmEvent) {
  await db.withClient(async (client) => {
    await client.query('BEGIN');

    try {
      // 1. Insert event
      const eventResult = await client.query(
        `INSERT INTO events (city_id, metric, event_date_local, timezone, unit, event_slug, polymarket_event_id, market_opened_at)
         VALUES ($1, 'TMAX', $2, $3, $4, $5, $6, now())
         ON CONFLICT (city_id, event_date_local, metric) DO NOTHING
         RETURNING event_id`,
        [city.city_id, dateLocal, city.timezone, city.unit, slug, pmEvent.id],
      );

      if (eventResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return;
      }

      const eventId = eventResult.rows[0].event_id;

      // 2. Extract and sort markets
      const markets = extractMarkets(pmEvent);

      if (markets.length === 0) {
        logger.warn({ slug, pmEventId: pmEvent.id }, 'Event found but has no markets');
        await client.query('COMMIT');
        return;
      }

      // 3. Insert market_dim rows
      const now = new Date();
      for (const m of markets) {
        await client.query(
          `INSERT INTO market_dim
           (market_id, event_id, bin_type, bin_low, bin_high, label, token_id_yes, token_id_no, condition_id, valid_from)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (market_id, valid_from) DO NOTHING`,
          [m.marketId, eventId, m.binType, m.binLow, m.binHigh, m.label,
           m.tokenIdYes, m.tokenIdNo, m.conditionId, now],
        );
      }

      // 4. Fetch initial prices via batch endpoints and create first orderbook state
      const initialState = await buildInitialOrderbookState(client, eventId, markets);

      // 5. Create market_open_context (with initial volume from Gamma API)
      const initialVolume = parseFloat(pmEvent.volume) || null;
      await client.query(
        `INSERT INTO market_open_context (event_id, opened_at, initial_orderbook_state_id, initial_volume)
         VALUES ($1, now(), $2, $3)
         ON CONFLICT (event_id) DO NOTHING`,
        [eventId, initialState?.stateId || null, initialVolume],
      );

      await client.query('COMMIT');

      logger.info({
        eventId,
        city: city.city_id,
        date: dateLocal,
        markets: markets.length,
        labels: markets.map(m => m.label),
      }, 'Event registered with market_dim rows');

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

/**
 * Fetch initial prices using batch CLOB endpoints and insert the first orderbook state.
 */
async function buildInitialOrderbookState(client, eventId, markets) {
  const { computeHash } = require('../collector/stateManager');

  try {
    // Build market_dim-like objects for fetchEventPrices
    const dimLike = markets.map(m => ({ token_id_yes: m.tokenIdYes }));
    const prices = await fetchEventPrices(dimLike);

    const midsCents = prices.map(p => Math.round(p.mid * 100));
    const spreadsCents = prices.map(p => Math.round(p.spread * 100));

    const stateHash = computeHash(midsCents);
    const now = new Date();

    const result = await client.query(
      `INSERT INTO event_orderbook_state
       (event_id, valid_from, state_hash, mids_cents, spreads_cents)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING state_id`,
      [eventId, now, stateHash, midsCents, spreadsCents],
    );

    return { stateId: result.rows[0].state_id };
  } catch (err) {
    logger.warn({ err: err.message, eventId }, 'Failed to build initial orderbook state');
    return null;
  }
}

/**
 * Get all active (open, not resolved, not closed) events.
 */
async function getActiveEvents() {
  const result = await db.query(
    `SELECT e.event_id, e.city_id, e.event_date_local, e.timezone, e.unit, e.event_slug,
            e.polymarket_event_id, e.resolved_at, e.market_closed_at
     FROM events e
     WHERE e.resolved_at IS NULL
       AND e.market_closed_at IS NULL
     ORDER BY e.event_date_local, e.city_id`,
  );
  return result.rows;
}

/**
 * Get the current market_dim rows for an event, sorted by bin order.
 */
async function getEventMarketDims(eventId) {
  const result = await db.query(
    `SELECT market_dim_id, market_id, bin_type, bin_low, bin_high, label,
            token_id_yes, token_id_no, condition_id
     FROM market_dim
     WHERE event_id = $1 AND is_current = true
     ORDER BY
       CASE bin_type
         WHEN 'LE' THEN 0
         WHEN 'RANGE' THEN 1
         WHEN 'EQ' THEN 1
         WHEN 'GE' THEN 2
       END,
       COALESCE(bin_low, -999999)`,
    [eventId],
  );
  return result.rows;
}

module.exports = {
  discoverMarkets,
  registerEvent,
  getActiveEvents,
  getEventMarketDims,
};
