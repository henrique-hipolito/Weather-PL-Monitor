'use strict';

const config = require('../config');
const logger = require('../utils/logger');
const { withRetry } = require('../utils/retry');

// ─── HTTP helper ─────────────────────────────────────────────────────────────

async function fetchJson(url, label, headers = {}) {
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'polymarket-weather-bot/1.0 (contact@example.com)',
      ...headers,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} for ${label}`);
    err.status = res.status;
    throw err;
  }

  return res.json();
}

// ─── NWS gridpoint cache ────────────────────────────────────────────────────
// NWS requires a two-step lookup: lat/lon → gridpoint → forecast.
// We cache the gridpoint info per city to avoid repeated lookups.

const nwsGridCache = new Map();

/**
 * Resolve NWS gridpoint (office, gridX, gridY) for a lat/lon.
 * Cached after first successful lookup.
 */
async function resolveNwsGrid(cityId, lat, lon) {
  if (nwsGridCache.has(cityId)) {
    return nwsGridCache.get(cityId);
  }

  const url = `${config.NWS_BASE}/points/${lat},${lon}`;
  const data = await withRetry(
    () => fetchJson(url, `nws:points:${cityId}`),
    { label: `nws:points:${cityId}`, circuitKey: 'nws' },
  );

  if (!data || !data.properties) {
    logger.warn({ cityId, lat, lon }, 'NWS points lookup returned no data');
    return null;
  }

  const grid = {
    office: data.properties.gridId,           // e.g. 'OKX'
    gridX: data.properties.gridX,
    gridY: data.properties.gridY,
    forecastUrl: data.properties.forecast,     // full URL to forecast endpoint
    stationUrl: data.properties.observationStations, // URL to list stations
  };

  nwsGridCache.set(cityId, grid);
  logger.info({ cityId, ...grid }, 'NWS gridpoint resolved and cached');
  return grid;
}

// ─── NOAA / NWS forecast ────────────────────────────────────────────────────

/**
 * Fetch temperature max forecast from NWS for a US city.
 *
 * @param {Object} city - City config object
 * @param {string} targetDateLocal - 'YYYY-MM-DD' in the city's local tz
 * @returns {{ tPoint: number, unit: string, source: string } | null}
 */
async function fetchNwsForecast(city, targetDateLocal) {
  const grid = await resolveNwsGrid(city.city_id, city.lat, city.lon);
  if (!grid) return null;

  const url = grid.forecastUrl;
  const data = await withRetry(
    () => fetchJson(url, `nws:forecast:${city.city_id}`),
    { label: `nws:forecast:${city.city_id}`, circuitKey: 'nws' },
  );

  if (!data || !data.properties || !data.properties.periods) {
    logger.warn({ city: city.city_id }, 'NWS forecast returned no periods');
    return null;
  }

  // NWS returns periods like "Today", "Tonight", "Monday", "Monday Night", etc.
  // Daytime periods have isDaytime=true and contain the high temperature.
  // We need to match the period to our target date.
  const periods = data.properties.periods;

  for (const period of periods) {
    if (!period.isDaytime) continue;

    // Extract the date from the period's startTime (ISO 8601)
    const periodDate = period.startTime.slice(0, 10); // 'YYYY-MM-DD'
    if (periodDate === targetDateLocal) {
      return {
        tPoint: period.temperature,
        unit: period.temperatureUnit === 'F' ? 'F' : 'C',
        source: `NOAA_NWS:${grid.office}`,
        modelRun: null, // NWS doesn't expose model run time in this endpoint
      };
    }
  }

  logger.debug({ city: city.city_id, targetDateLocal, periodsCount: periods.length },
    'NWS forecast: target date not found in periods');
  return null;
}

// ─── Open-Meteo forecast ────────────────────────────────────────────────────

/**
 * Fetch temperature max forecast from Open-Meteo for any city.
 *
 * @param {Object} city - City config object
 * @param {string} targetDateLocal - 'YYYY-MM-DD' in the city's local tz
 * @returns {{ tPoint: number, unit: string, source: string, modelRun: Date|null } | null}
 */
async function fetchOpenMeteoForecast(city, targetDateLocal) {
  // Determine temperature unit parameter
  // Open-Meteo defaults to °C. For US cities (fallback), we need °F.
  const tempUnit = city.unit === 'F' ? '&temperature_unit=fahrenheit' : '';

  const url =
    `${config.OPEN_METEO_BASE}` +
    `?latitude=${city.lat}&longitude=${city.lon}` +
    `&daily=temperature_2m_max` +
    `&timezone=${encodeURIComponent(city.timezone)}` +
    `&forecast_days=3` +
    tempUnit;

  const data = await withRetry(
    () => fetchJson(url, `openmeteo:forecast:${city.city_id}`),
    { label: `openmeteo:forecast:${city.city_id}`, circuitKey: 'openmeteo' },
  );

  if (!data || !data.daily || !data.daily.time || !data.daily.temperature_2m_max) {
    logger.warn({ city: city.city_id }, 'Open-Meteo returned no daily data');
    return null;
  }

  const times = data.daily.time;          // ['2026-02-23', '2026-02-24', '2026-02-25']
  const temps = data.daily.temperature_2m_max; // [12.3, 14.1, 11.8]

  const idx = times.indexOf(targetDateLocal);
  if (idx === -1) {
    logger.debug({ city: city.city_id, targetDateLocal, availableDates: times },
      'Open-Meteo: target date not in response');
    return null;
  }

  const tMax = temps[idx];
  if (tMax == null) {
    logger.debug({ city: city.city_id, targetDateLocal }, 'Open-Meteo: tMax is null for target date');
    return null;
  }

  return {
    tPoint: Math.round(tMax * 10) / 10, // 1 decimal precision
    unit: city.unit,
    source: 'Open-Meteo',
    modelRun: null, // Open-Meteo doesn't expose this in the simple endpoint
  };
}

// ─── Unified forecast fetcher with fallback ─────────────────────────────────

/**
 * Fetch the best available forecast for a city and target date.
 * US cities: try NWS first, fallback to Open-Meteo.
 * International cities: Open-Meteo only.
 *
 * @param {Object} city - City config object
 * @param {string} targetDateLocal - 'YYYY-MM-DD'
 * @returns {{ tPoint: number, unit: string, source: string, modelRun: Date|null } | null}
 */
async function fetchForecast(city, targetDateLocal) {
  if (city.provider === 'NOAA_NWS') {
    // Try NWS first
    const nws = await fetchNwsForecast(city, targetDateLocal);
    if (nws) return nws;

    // Fallback to Open-Meteo
    logger.info({ city: city.city_id, targetDateLocal },
      'NWS failed — falling back to Open-Meteo');
    const om = await fetchOpenMeteoForecast(city, targetDateLocal);
    if (om) {
      om.source = 'Open-Meteo:fallback';
      return om;
    }

    return null;
  }

  // International: Open-Meteo only
  return fetchOpenMeteoForecast(city, targetDateLocal);
}

// ─── NWS station cache ──────────────────────────────────────────────────────
// Resolves the nearest observation station for a city. Cached in-memory.

const nwsStationCache = new Map();

/**
 * Resolve the nearest NWS observation station for a city.
 * Uses the stationUrl from the gridpoint lookup.
 * @returns {string|null} stationId e.g. 'KNYC'
 */
async function resolveNwsStation(city) {
  if (nwsStationCache.has(city.city_id)) {
    return nwsStationCache.get(city.city_id);
  }

  const grid = await resolveNwsGrid(city.city_id, city.lat, city.lon);
  if (!grid || !grid.stationUrl) return null;

  const data = await withRetry(
    () => fetchJson(grid.stationUrl, `nws:stations:${city.city_id}`),
    { label: `nws:stations:${city.city_id}`, circuitKey: 'nws' },
  );

  if (!data || !data.features || data.features.length === 0) {
    logger.warn({ city: city.city_id }, 'NWS stations list is empty');
    return null;
  }

  // First station is the nearest
  const stationId = data.features[0].properties.stationIdentifier;
  nwsStationCache.set(city.city_id, stationId);
  logger.info({ city: city.city_id, stationId }, 'NWS station resolved and cached');
  return stationId;
}

// ─── Current temperature (intraday observations) ────────────────────────────

/**
 * Fetch current observed temperature for a US city from NWS.
 * NWS returns °C — converts to °F for US cities.
 *
 * @param {Object} city
 * @returns {{ value: number, unit: string, source: string, stationId: string } | null}
 */
async function fetchNwsCurrentTemp(city) {
  const stationId = await resolveNwsStation(city);
  if (!stationId) return null;

  const url = `${config.NWS_BASE}/stations/${stationId}/observations/latest`;
  const data = await withRetry(
    () => fetchJson(url, `nws:obs:latest:${city.city_id}`),
    { label: `nws:obs:latest:${city.city_id}`, circuitKey: 'nws' },
  );

  if (!data || !data.properties || !data.properties.temperature) return null;

  const tempC = data.properties.temperature.value;
  if (tempC == null) return null;

  // NWS always returns °C; convert to °F for US cities
  const value = city.unit === 'F'
    ? Math.round(((tempC * 9 / 5) + 32) * 10) / 10
    : Math.round(tempC * 10) / 10;

  return {
    value,
    unit: city.unit,
    source: `NOAA_NWS:${stationId}`,
    stationId,
  };
}

/**
 * Fetch current observed temperature for an international city from Open-Meteo.
 *
 * @param {Object} city
 * @returns {{ value: number, unit: string, source: string } | null}
 */
async function fetchOpenMeteoCurrentTemp(city) {
  const tempUnit = city.unit === 'F' ? '&temperature_unit=fahrenheit' : '';
  const url =
    `${config.OPEN_METEO_BASE}` +
    `?latitude=${city.lat}&longitude=${city.lon}` +
    `&current=temperature_2m` +
    `&timezone=${encodeURIComponent(city.timezone)}` +
    tempUnit;

  const data = await withRetry(
    () => fetchJson(url, `openmeteo:current:${city.city_id}`),
    { label: `openmeteo:current:${city.city_id}`, circuitKey: 'openmeteo' },
  );

  if (!data || !data.current || data.current.temperature_2m == null) return null;

  return {
    value: Math.round(data.current.temperature_2m * 10) / 10,
    unit: city.unit,
    source: 'Open-Meteo',
  };
}

/**
 * Fetch current observed temperature for any city (unified with fallback).
 */
async function fetchCurrentTemp(city) {
  if (city.provider === 'NOAA_NWS') {
    const nws = await fetchNwsCurrentTemp(city);
    if (nws) return nws;

    logger.info({ city: city.city_id }, 'NWS current temp failed — falling back to Open-Meteo');
    const om = await fetchOpenMeteoCurrentTemp(city);
    if (om) {
      om.source = 'Open-Meteo:fallback';
      return om;
    }
    return null;
  }

  return fetchOpenMeteoCurrentTemp(city);
}

// ─── Daily TMAX (consolidated max of day) ───────────────────────────────────

/**
 * Fetch consolidated TMAX from NWS for a US city on a specific date.
 * Iterates all observations of the day and finds the maximum.
 *
 * @param {Object} city
 * @param {string} dateLocal - 'YYYY-MM-DD'
 * @returns {{ value: number, unit: string, source: string, stationId: string } | null}
 */
async function fetchNwsDailyTmax(city, dateLocal) {
  const stationId = await resolveNwsStation(city);
  if (!stationId) return null;

  const url =
    `${config.NWS_BASE}/stations/${stationId}/observations` +
    `?start=${dateLocal}T00:00:00Z&end=${dateLocal}T23:59:59Z`;

  const data = await withRetry(
    () => fetchJson(url, `nws:obs:daily:${city.city_id}`),
    { label: `nws:obs:daily:${city.city_id}`, circuitKey: 'nws' },
  );

  if (!data || !data.features || data.features.length === 0) return null;

  // Find max temperature across all observations
  let maxTempC = -Infinity;
  for (const obs of data.features) {
    const t = obs.properties?.temperature?.value;
    if (t != null && t > maxTempC) {
      maxTempC = t;
    }
  }

  if (maxTempC === -Infinity) return null;

  const value = city.unit === 'F'
    ? Math.round(((maxTempC * 9 / 5) + 32) * 10) / 10
    : Math.round(maxTempC * 10) / 10;

  return {
    value,
    unit: city.unit,
    source: `NOAA_NWS:${stationId}`,
    stationId,
  };
}

/**
 * Fetch consolidated TMAX from Open-Meteo historical archive.
 *
 * @param {Object} city
 * @param {string} dateLocal - 'YYYY-MM-DD'
 * @returns {{ value: number, unit: string, source: string } | null}
 */
async function fetchOpenMeteoDailyTmax(city, dateLocal) {
  const tempUnit = city.unit === 'F' ? '&temperature_unit=fahrenheit' : '';
  const url =
    `${config.OPEN_METEO_HISTORICAL_BASE}` +
    `?latitude=${city.lat}&longitude=${city.lon}` +
    `&start_date=${dateLocal}&end_date=${dateLocal}` +
    `&daily=temperature_2m_max` +
    `&timezone=${encodeURIComponent(city.timezone)}` +
    tempUnit;

  const data = await withRetry(
    () => fetchJson(url, `openmeteo:tmax:${city.city_id}`),
    { label: `openmeteo:tmax:${city.city_id}`, circuitKey: 'openmeteo' },
  );

  if (!data || !data.daily || !data.daily.temperature_2m_max) return null;

  const tMax = data.daily.temperature_2m_max[0];
  if (tMax == null) return null;

  return {
    value: Math.round(tMax * 10) / 10,
    unit: city.unit,
    source: 'Open-Meteo:historical',
  };
}

/**
 * Fetch consolidated TMAX for any city (unified with fallback).
 */
async function fetchDailyTmax(city, dateLocal) {
  if (city.provider === 'NOAA_NWS') {
    const nws = await fetchNwsDailyTmax(city, dateLocal);
    if (nws) return nws;

    logger.info({ city: city.city_id, dateLocal }, 'NWS TMAX failed — falling back to Open-Meteo');
    const om = await fetchOpenMeteoDailyTmax(city, dateLocal);
    if (om) {
      om.source = 'Open-Meteo:historical:fallback';
      return om;
    }
    return null;
  }

  return fetchOpenMeteoDailyTmax(city, dateLocal);
}

module.exports = {
  fetchNwsForecast,
  fetchOpenMeteoForecast,
  fetchForecast,
  resolveNwsGrid,
  resolveNwsStation,
  fetchCurrentTemp,
  fetchDailyTmax,
};
