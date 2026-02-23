'use strict';

const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const logger = require('../utils/logger');

// ─── Hash computation ────────────────────────────────────────────────────────

/**
 * Compute SHA-256 hash of an array of integers (mids_cents).
 * Returns a Buffer suitable for BYTEA storage.
 */
function computeHash(intArray) {
  const str = intArray.join(',');
  return crypto.createHash('sha256').update(str).digest();
}

/**
 * Compute forecast hash from t_point value.
 * We round to 1 decimal to avoid floating point noise.
 */
function computeForecastHash(tPoint) {
  const rounded = Math.round(tPoint * 10) / 10;
  return crypto.createHash('sha256').update(String(rounded)).digest();
}

// ─── Orderbook state SCD2 ────────────────────────────────────────────────────

/**
 * Check if new orderbook state differs from current, and if so, perform SCD2 transition.
 *
 * @param {string} eventId
 * @param {number[]} newMidsCents - Array of mid prices in cents, sorted by bin order
 * @param {number[]} newSpreadsCents - Array of spreads in cents
 * @param {Object} aggregates - { sumBidSize, sumAskSize, volume24h, volumeTotal, openInterest }
 * @returns {boolean} true if a new state was inserted
 */
async function updateOrderbookState(eventId, newMidsCents, newSpreadsCents, aggregates = {}) {
  const newHash = computeHash(newMidsCents);

  return db.withClient(async (client) => {
    await client.query('BEGIN');
    try {
      // 1. Get current state
      const current = await client.query(
        `SELECT state_id, state_hash, mids_cents
         FROM event_orderbook_state
         WHERE event_id = $1 AND is_current = true
         FOR UPDATE`,
        [eventId],
      );

      // 2. Compare hash
      if (current.rows.length > 0) {
        const currentHash = current.rows[0].state_hash;
        if (Buffer.compare(currentHash, newHash) === 0) {
          await client.query('ROLLBACK');
          return false; // no change
        }

        // Check minimum change threshold
        const currentMids = current.rows[0].mids_cents;
        const maxDelta = maxMidDelta(currentMids, newMidsCents);
        if (maxDelta < config.BOOK_CHANGE_THRESHOLD_CENTS) {
          await client.query('ROLLBACK');
          return false; // change below threshold
        }

        // 3. Close current state
        const now = new Date();
        await client.query(
          `UPDATE event_orderbook_state
           SET valid_to = $1, is_current = false
           WHERE state_id = $2`,
          [now, current.rows[0].state_id],
        );
      }

      // 4. Insert new state
      const now = new Date();
      await client.query(
        `INSERT INTO event_orderbook_state
         (event_id, valid_from, state_hash, mids_cents, spreads_cents,
          sum_bid_size, sum_ask_size, volume_24h, volume_total, open_interest)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [eventId, now, newHash, newMidsCents, newSpreadsCents,
         aggregates.sumBidSize || null, aggregates.sumAskSize || null,
         aggregates.volume24h || null, aggregates.volumeTotal || null,
         aggregates.openInterest || null],
      );

      await client.query('COMMIT');
      return true;

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

// ─── Forecast state SCD2 ────────────────────────────────────────────────────

/**
 * Check if forecast changed beyond threshold and perform SCD2 transition.
 *
 * @param {string} eventId
 * @param {Object} forecast - { source, tPoint, tP10, tP50, tP90, unit, modelRun, horizonHours }
 * @returns {boolean} true if a new state was inserted
 */
async function updateForecastState(eventId, forecast) {
  const newHash = computeForecastHash(forecast.tPoint);

  return db.withClient(async (client) => {
    await client.query('BEGIN');
    try {
      // 1. Get current state
      const current = await client.query(
        `SELECT forecast_state_id, t_point
         FROM event_forecast_state
         WHERE event_id = $1 AND is_current = true
         FOR UPDATE`,
        [eventId],
      );

      // 2. Check threshold
      if (current.rows.length > 0) {
        const currentTPoint = parseFloat(current.rows[0].t_point);
        const delta = Math.abs(forecast.tPoint - currentTPoint);

        if (delta < config.FORECAST_CHANGE_THRESHOLD) {
          await client.query('ROLLBACK');
          return false; // below threshold
        }

        // 3. Close current state
        const now = new Date();
        await client.query(
          `UPDATE event_forecast_state
           SET valid_to = $1, is_current = false
           WHERE forecast_state_id = $2`,
          [now, current.rows[0].forecast_state_id],
        );
      }

      // 4. Insert new state
      const now = new Date();
      await client.query(
        `INSERT INTO event_forecast_state
         (event_id, valid_from, forecast_hash, source, model_run, horizon_hours,
          t_point, t_p10, t_p50, t_p90, unit)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [eventId, now, newHash, forecast.source,
         forecast.modelRun || null, forecast.horizonHours || null,
         forecast.tPoint, forecast.tP10 || null, forecast.tP50 || null,
         forecast.tP90 || null, forecast.unit],
      );

      await client.query('COMMIT');
      return true;

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Compute the maximum absolute delta between two arrays of mid-cents.
 */
function maxMidDelta(a, b) {
  const len = Math.max(a.length, b.length);
  let maxDelta = 0;
  for (let i = 0; i < len; i++) {
    const delta = Math.abs((a[i] || 0) - (b[i] || 0));
    if (delta > maxDelta) maxDelta = delta;
  }
  return maxDelta;
}

module.exports = {
  computeHash,
  computeForecastHash,
  updateOrderbookState,
  updateForecastState,
};
