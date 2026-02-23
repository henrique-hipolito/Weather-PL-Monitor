'use strict';

// ─── Intervals ───────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS = 60_000;                // 1 min  — book polling
const FORECAST_INTERVAL_MS = 30 * 60_000;       // 30 min — forecast refresh
const MARKET_DISCOVERY_INTERVAL_MS = 15 * 60_000; // 15 min — discover new events
const OBSERVATION_INTERVAL_MS = 60_000;           // 1 min  — intraday temp observation
const TMAX_CHECK_INTERVAL_MS = 60 * 60_000;       // 1 hour — check if time to collect TMAX

// ─── Thresholds ──────────────────────────────────────────────────────────────
const BOOK_CHANGE_THRESHOLD_CENTS = 1;          // min 1 cent change in any mid
const FORECAST_CHANGE_THRESHOLD = 0.5;          // 0.5 degree change to save
const OBSERVATION_CHANGE_THRESHOLD = 0.5;       // 0.5 degree change to save intraday obs

// ─── Resolution ──────────────────────────────────────────────────────────────
const RESOLUTION_CONSECUTIVE_SNAPSHOTS = 3;
const RESOLUTION_PRICE_THRESHOLD = 0.99;

// ─── Retry / Circuit Breaker ─────────────────────────────────────────────────
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000;
const CIRCUIT_BREAKER_THRESHOLD = 10;           // consecutive failures to trip
const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60_000; // 5 min pause after trip

// ─── API bases ───────────────────────────────────────────────────────────────
const POLYMARKET_RATE_LIMIT_RPS = 10;
const POLYMARKET_GAMMA_BASE = 'https://gamma-api.polymarket.com';
const POLYMARKET_CLOB_BASE = 'https://clob.polymarket.com';
const NWS_BASE = 'https://api.weather.gov';
const OPEN_METEO_BASE = 'https://api.open-meteo.com/v1/forecast';
const OPEN_METEO_HISTORICAL_BASE = 'https://archive-api.open-meteo.com/v1/archive';

// ─── Misc ────────────────────────────────────────────────────────────────────
const DAYS_AHEAD = 2;
const HEARTBEAT_STALE_MS = 3 * 60_000;         // 3 min without heartbeat = alert

// ─── Cities ──────────────────────────────────────────────────────────────────
const CITIES = [
  // US cities — NOAA/NWS, °F
  { city_id: 'nyc_us',       name: 'New York City', country_code: 'US', timezone: 'America/New_York',              lat: 40.7128,   lon: -74.0060,  slug_name: 'nyc',          unit: 'F', provider: 'NOAA_NWS' },
  { city_id: 'atlanta_us',   name: 'Atlanta',       country_code: 'US', timezone: 'America/New_York',              lat: 33.7490,   lon: -84.3880,  slug_name: 'atlanta',      unit: 'F', provider: 'NOAA_NWS' },
  { city_id: 'chicago_us',   name: 'Chicago',       country_code: 'US', timezone: 'America/Chicago',               lat: 41.8781,   lon: -87.6298,  slug_name: 'chicago',      unit: 'F', provider: 'NOAA_NWS' },
  { city_id: 'miami_us',     name: 'Miami',         country_code: 'US', timezone: 'America/New_York',              lat: 25.7617,   lon: -80.1918,  slug_name: 'miami',        unit: 'F', provider: 'NOAA_NWS' },
  { city_id: 'seattle_us',   name: 'Seattle',       country_code: 'US', timezone: 'America/Los_Angeles',           lat: 47.6062,   lon: -122.3321, slug_name: 'seattle',      unit: 'F', provider: 'NOAA_NWS' },
  { city_id: 'dallas_us',    name: 'Dallas',        country_code: 'US', timezone: 'America/Chicago',               lat: 32.7767,   lon: -96.7970,  slug_name: 'dallas',       unit: 'F', provider: 'NOAA_NWS' },
  // International cities — Open-Meteo, °C
  { city_id: 'buenosaires_ar', name: 'Buenos Aires', country_code: 'AR', timezone: 'America/Argentina/Buenos_Aires', lat: -34.6037, lon: -58.3816, slug_name: 'buenos-aires', unit: 'C', provider: 'OPEN_METEO' },
  { city_id: 'seoul_kr',       name: 'Seoul',        country_code: 'KR', timezone: 'Asia/Seoul',                     lat: 37.5665,  lon: 126.9780, slug_name: 'seoul',        unit: 'C', provider: 'OPEN_METEO' },
  { city_id: 'london_gb',      name: 'London',       country_code: 'GB', timezone: 'Europe/London',                  lat: 51.5074,  lon: -0.1278,  slug_name: 'london',       unit: 'C', provider: 'OPEN_METEO' },
  { city_id: 'saopaulo_br',    name: 'São Paulo',    country_code: 'BR', timezone: 'America/Sao_Paulo',              lat: -23.5505, lon: -46.6333, slug_name: 'sao-paulo',    unit: 'C', provider: 'OPEN_METEO' },
  { city_id: 'wellington_nz',  name: 'Wellington',   country_code: 'NZ', timezone: 'Pacific/Auckland',               lat: -41.2865, lon: 174.7762, slug_name: 'wellington',   unit: 'C', provider: 'OPEN_METEO' },
  { city_id: 'toronto_ca',     name: 'Toronto',      country_code: 'CA', timezone: 'America/Toronto',                lat: 43.6532,  lon: -79.3832, slug_name: 'toronto',      unit: 'C', provider: 'OPEN_METEO' },
];

// Lookup maps
const CITY_BY_ID = new Map(CITIES.map(c => [c.city_id, c]));
const US_CITIES = CITIES.filter(c => c.provider === 'NOAA_NWS');
const INTL_CITIES = CITIES.filter(c => c.provider === 'OPEN_METEO');

module.exports = {
  // Intervals
  POLL_INTERVAL_MS,
  FORECAST_INTERVAL_MS,
  MARKET_DISCOVERY_INTERVAL_MS,
  OBSERVATION_INTERVAL_MS,
  TMAX_CHECK_INTERVAL_MS,

  // Thresholds
  BOOK_CHANGE_THRESHOLD_CENTS,
  FORECAST_CHANGE_THRESHOLD,
  OBSERVATION_CHANGE_THRESHOLD,

  // Resolution
  RESOLUTION_CONSECUTIVE_SNAPSHOTS,
  RESOLUTION_PRICE_THRESHOLD,

  // Retry / Circuit breaker
  MAX_RETRIES,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  CIRCUIT_BREAKER_THRESHOLD,
  CIRCUIT_BREAKER_COOLDOWN_MS,

  // API
  POLYMARKET_RATE_LIMIT_RPS,
  POLYMARKET_GAMMA_BASE,
  POLYMARKET_CLOB_BASE,
  NWS_BASE,
  OPEN_METEO_BASE,
  OPEN_METEO_HISTORICAL_BASE,

  // Misc
  DAYS_AHEAD,
  HEARTBEAT_STALE_MS,

  // Cities
  CITIES,
  CITY_BY_ID,
  US_CITIES,
  INTL_CITIES,
};
