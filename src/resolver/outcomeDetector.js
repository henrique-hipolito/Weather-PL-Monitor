'use strict';

const config = require('../config');
const db = require('../db');
const logger = require('../utils/logger');

// In-memory tracker: eventId → { label, consecutiveCount }
const resolutionTracker = new Map();

/**
 * Check if any outcome in the event has reached resolution threshold.
 *
 * Resolution criteria:
 *   - YES price >= 0.99 for RESOLUTION_CONSECUTIVE_SNAPSHOTS consecutive polls
 *
 * @param {string} eventId
 * @param {Array<{ label: string, yesPrice: number }>} yesPrices - Prices in bin order
 * @returns {boolean} true if event was just resolved
 */
async function checkResolution(eventId, yesPrices) {
  // Find the outcome with highest YES price
  let candidate = null;
  for (const p of yesPrices) {
    if (p.yesPrice >= config.RESOLUTION_PRICE_THRESHOLD) {
      candidate = p;
      break; // Only one outcome can be at 0.99+ in a well-formed market
    }
  }

  if (!candidate) {
    // No outcome at threshold — reset tracker
    resolutionTracker.delete(eventId);
    return false;
  }

  // Track consecutive snapshots
  const tracker = resolutionTracker.get(eventId);

  if (tracker && tracker.label === candidate.label) {
    tracker.consecutiveCount++;
  } else {
    // New candidate or different label — reset
    resolutionTracker.set(eventId, {
      label: candidate.label,
      consecutiveCount: 1,
    });
  }

  const current = resolutionTracker.get(eventId);

  if (current.consecutiveCount >= config.RESOLUTION_CONSECUTIVE_SNAPSHOTS) {
    // Resolve!
    await markResolved(eventId, current.label);
    resolutionTracker.delete(eventId);
    return true;
  }

  logger.debug({
    eventId,
    label: current.label,
    count: current.consecutiveCount,
    needed: config.RESOLUTION_CONSECUTIVE_SNAPSHOTS,
  }, 'Resolution candidate tracking');

  return false;
}

/**
 * Mark an event as resolved in the database.
 */
async function markResolved(eventId, outcomeLabel) {
  await db.query(
    `UPDATE events
     SET resolved_outcome_label = $1,
         resolved_at = now(),
         market_closed_at = now()
     WHERE event_id = $2
       AND resolved_at IS NULL`,
    [outcomeLabel, eventId],
  );

  logger.info({ eventId, outcomeLabel }, 'Event RESOLVED');
}

/**
 * Reset the in-memory tracker (for testing or restart).
 */
function resetTracker() {
  resolutionTracker.clear();
}

module.exports = { checkResolution, resetTracker };
