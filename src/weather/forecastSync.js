'use strict';

const config = require('../config');
const logger = require('../utils/logger');
const { fetchForecast } = require('./client');
const { getActiveEvents } = require('../polymarket/marketSync');
const { updateForecastState } = require('../collector/stateManager');
const { hoursUntilEndOfDay } = require('../utils/timezone');

/**
 * Run one cycle of forecast collection for all active events.
 */
async function syncForecasts() {
  const events = await getActiveEvents();
  const stats = { updated: 0, unchanged: 0, failed: 0 };

  for (const event of events) {
    try {
      const city = config.CITY_BY_ID.get(event.city_id);
      if (!city) {
        logger.warn({ cityId: event.city_id }, 'City not found in config — skipping forecast');
        stats.failed++;
        continue;
      }

      const targetDateLocal = event.event_date_local;

      // Fetch forecast
      const forecast = await fetchForecast(city, targetDateLocal);
      if (!forecast) {
        logger.debug({ city: city.city_id, date: targetDateLocal }, 'No forecast available');
        stats.failed++;
        continue;
      }

      // Compute horizon
      const horizonHours = hoursUntilEndOfDay(targetDateLocal, city.timezone);

      // Update SCD2 state (will skip if below threshold)
      const changed = await updateForecastState(event.event_id, {
        source: forecast.source,
        tPoint: forecast.tPoint,
        tP10: forecast.tP10 || null,
        tP50: forecast.tP50 || null,
        tP90: forecast.tP90 || null,
        unit: forecast.unit,
        modelRun: forecast.modelRun || null,
        horizonHours,
      });

      if (changed) {
        stats.updated++;
        logger.info({
          city: city.city_id,
          date: targetDateLocal,
          tPoint: forecast.tPoint,
          unit: forecast.unit,
          source: forecast.source,
          horizonHours,
        }, 'Forecast state updated');
      } else {
        stats.unchanged++;
      }
    } catch (err) {
      stats.failed++;
      logger.error({ err: err.message, eventId: event.event_id }, 'Error syncing forecast');
    }
  }

  logger.info({ ...stats, totalEvents: events.length }, 'Forecast sync cycle complete');
  return stats;
}

module.exports = { syncForecasts };
