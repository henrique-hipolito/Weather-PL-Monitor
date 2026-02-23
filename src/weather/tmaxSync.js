'use strict';

const { DateTime } = require('luxon');
const config = require('../config');
const db = require('../db');
const logger = require('../utils/logger');
const { fetchDailyTmax } = require('./client');

/**
 * Check if it's time to collect TMAX for each city, and collect if needed.
 * Runs every hour. For each city, collects TMAX when local hour is 23.
 * Also attempts fallback collection at local hour 0 for the previous day.
 */
async function checkAndSyncTmax() {
  const stats = { collected: 0, skipped: 0, failed: 0 };

  for (const city of config.CITIES) {
    try {
      const now = DateTime.now().setZone(city.timezone);
      const localHour = now.hour;

      let targetDateLocal = null;

      if (localHour === 23) {
        // Primary window: collect today's TMAX
        targetDateLocal = now.toISODate();
      } else if (localHour === 0) {
        // Fallback window: collect yesterday's TMAX if missed
        targetDateLocal = now.minus({ days: 1 }).toISODate();
      } else {
        stats.skipped++;
        continue;
      }

      // Check if already collected
      const existing = await db.query(
        `SELECT 1 FROM observations
         WHERE city_id = $1 AND obs_date_local = $2 AND metric = 'TMAX'`,
        [city.city_id, targetDateLocal],
      );

      if (existing.rows.length > 0) {
        stats.skipped++;
        continue;
      }

      // Check if there's an event for this date (don't collect if no event)
      const event = await db.query(
        `SELECT event_id FROM events
         WHERE city_id = $1 AND event_date_local = $2 AND metric = 'TMAX'`,
        [city.city_id, targetDateLocal],
      );

      if (event.rows.length === 0) {
        stats.skipped++;
        continue;
      }

      // Fetch TMAX
      const tmax = await fetchDailyTmax(city, targetDateLocal);
      if (!tmax) {
        stats.failed++;
        logger.warn({ city: city.city_id, date: targetDateLocal }, 'Failed to fetch daily TMAX');
        continue;
      }

      // Save to observations (idempotent via PK)
      await db.query(
        `INSERT INTO observations
         (city_id, station_id, obs_timestamp, obs_date_local, metric, unit, value, source)
         VALUES ($1, $2, now(), $3, 'TMAX', $4, $5, $6)
         ON CONFLICT (city_id, obs_date_local, metric, source) DO NOTHING`,
        [city.city_id, tmax.stationId || null, targetDateLocal, tmax.unit, tmax.value, tmax.source],
      );

      stats.collected++;
      logger.info({
        city: city.city_id,
        date: targetDateLocal,
        tmax: tmax.value,
        unit: tmax.unit,
        source: tmax.source,
      }, 'Daily TMAX collected');

    } catch (err) {
      stats.failed++;
      logger.error({ err: err.message, city: city.city_id }, 'Error collecting daily TMAX');
    }
  }

  if (stats.collected > 0 || stats.failed > 0) {
    logger.info({ ...stats }, 'TMAX check cycle complete');
  }

  return stats;
}

module.exports = { checkAndSyncTmax };
