'use strict';

const config = require('../config');
const db = require('../db');
const logger = require('../utils/logger');
const { utcToLocalDate } = require('../utils/timezone');
const { fetchCurrentTemp } = require('./client');
const { getActiveEvents } = require('../polymarket/marketSync');

/**
 * Run one cycle of intraday observation collection.
 * Only collects for cities that have active events today.
 */
async function syncObservations() {
  // Get active events to know which cities need observations
  const events = await getActiveEvents();

  // Dedupe: one observation per city per cycle (not per event)
  const citiesWithActiveEvents = new Set();
  const cityDateMap = new Map(); // city_id → earliest event_date_local
  for (const ev of events) {
    citiesWithActiveEvents.add(ev.city_id);
    if (!cityDateMap.has(ev.city_id)) {
      cityDateMap.set(ev.city_id, ev.event_date_local);
    }
  }

  const stats = { updated: 0, unchanged: 0, failed: 0 };

  for (const cityId of citiesWithActiveEvents) {
    try {
      const city = config.CITY_BY_ID.get(cityId);
      if (!city) continue;

      const temp = await fetchCurrentTemp(city);
      if (!temp) {
        stats.failed++;
        continue;
      }

      const obsDateLocal = utcToLocalDate(new Date(), city.timezone);

      const changed = await updateObservationIntraday(
        cityId,
        temp.value,
        temp.unit,
        temp.source,
        obsDateLocal,
        temp.stationId || null,
      );

      if (changed) {
        stats.updated++;
        logger.debug({ city: cityId, value: temp.value, unit: temp.unit }, 'Intraday obs updated');
      } else {
        stats.unchanged++;
      }
    } catch (err) {
      stats.failed++;
      logger.error({ err: err.message, city: cityId }, 'Error collecting intraday observation');
    }
  }

  logger.info({ ...stats, cities: citiesWithActiveEvents.size }, 'Observation sync cycle complete');
  return stats;
}

/**
 * SCD2-like update for intraday observations.
 * Only saves when temperature changes >= OBSERVATION_CHANGE_THRESHOLD.
 *
 * @returns {boolean} true if new observation was inserted
 */
async function updateObservationIntraday(cityId, newValue, unit, source, obsDateLocal, stationId) {
  return db.withClient(async (client) => {
    await client.query('BEGIN');
    try {
      // 1. Get current observation for this city
      const current = await client.query(
        `SELECT obs_id, value
         FROM observations_intraday
         WHERE city_id = $1 AND metric = 'TOBS' AND is_current = true
         FOR UPDATE`,
        [cityId],
      );

      // 2. Check threshold
      if (current.rows.length > 0) {
        const currentValue = parseFloat(current.rows[0].value);
        const delta = Math.abs(newValue - currentValue);

        if (delta < config.OBSERVATION_CHANGE_THRESHOLD) {
          await client.query('ROLLBACK');
          return false;
        }

        // 3. Close current observation
        const now = new Date();
        await client.query(
          `UPDATE observations_intraday
           SET valid_to = $1, is_current = false
           WHERE obs_id = $2`,
          [now, current.rows[0].obs_id],
        );
      }

      // 4. Insert new observation
      const now = new Date();
      await client.query(
        `INSERT INTO observations_intraday
         (city_id, station_id, valid_from, obs_date_local, metric, unit, value, source)
         VALUES ($1, $2, $3, $4, 'TOBS', $5, $6, $7)`,
        [cityId, stationId, now, obsDateLocal, unit, newValue, source],
      );

      await client.query('COMMIT');
      return true;

    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

module.exports = { syncObservations };
