'use strict';

const logger = require('../utils/logger');
const { getActiveEvents, getEventMarketDims } = require('../polymarket/marketSync');
const { fetchEventPricesFromGamma } = require('../polymarket/client');
const { updateOrderbookState } = require('./stateManager');
const { recordHeartbeat } = require('./heartbeat');
const { checkResolution } = require('../resolver/outcomeDetector');

/**
 * Run one cycle of book polling for all active events.
 */
async function pollBooks() {
  const events = await getActiveEvents();
  const stats = { polled: 0, updated: 0, unchanged: 0, resolved: 0, errors: 0 };

  for (const event of events) {
    try {
      await pollSingleEvent(event, stats);
    } catch (err) {
      stats.errors++;
      logger.error({ err: err.message, eventId: event.event_id, city: event.city_id },
        'Error polling event');
    }
  }

  logger.info({ ...stats, totalEvents: events.length }, 'Book polling cycle complete');
  return stats;
}

/**
 * Poll a single event: fetch prices from Gamma API, compute state, update SCD2, heartbeat.
 */
async function pollSingleEvent(event, stats) {
  const marketDims = await getEventMarketDims(event.event_id);

  if (marketDims.length === 0) {
    logger.debug({ eventId: event.event_id }, 'No market_dim rows — skipping');
    return;
  }

  // Single Gamma API request per event
  const prices = await fetchEventPricesFromGamma(event.polymarket_event_id, marketDims);

  // Build arrays in bin order
  const midsCents = prices.map(p => Math.round(p.mid * 100));
  const spreadsCents = prices.map(p => Math.round(p.spread * 100));

  // Build YES prices for resolution detection
  const yesPrices = marketDims.map((dim, i) => ({
    label: dim.label,
    yesPrice: prices[i].yesPrice,
  }));

  // Aggregate volume across all markets in the event
  const volume24h = prices.reduce((sum, p) => sum + (p.volume24h || 0), 0);

  stats.polled++;

  // Update orderbook state (SCD2 with hash check + threshold)
  const changed = await updateOrderbookState(
    event.event_id,
    midsCents,
    spreadsCents,
    { volume24h },
  );

  if (changed) {
    stats.updated++;
    logger.debug({
      eventId: event.event_id,
      city: event.city_id,
      date: event.event_date_local,
      mids: midsCents,
    }, 'Orderbook state updated');
  } else {
    stats.unchanged++;
  }

  // Always record heartbeat
  await recordHeartbeat(event.event_id);

  // Check for resolution
  const resolved = await checkResolution(event.event_id, yesPrices);
  if (resolved) {
    stats.resolved++;
  }
}

module.exports = { pollBooks };
