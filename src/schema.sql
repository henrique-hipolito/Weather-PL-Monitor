-- ============================================================================
-- Polymarket Weather Bot — Schema
-- All statements are idempotent (safe to re-run)
-- ============================================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Enums (wrapped in DO blocks for IF NOT EXISTS)
DO $$ BEGIN CREATE TYPE pm_outcome  AS ENUM ('YES', 'NO');            EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE trade_side  AS ENUM ('BUY', 'SELL');          EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE order_type  AS ENUM ('LIMIT', 'IOC', 'MARKET'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE temp_unit   AS ENUM ('F', 'C');               EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE metric_type AS ENUM ('TMAX');                 EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE metric_type ADD VALUE IF NOT EXISTS 'TOBS';   EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE bin_type    AS ENUM ('RANGE', 'GE', 'LE', 'EQ'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── cities ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cities (
  city_id      TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  country_code TEXT NOT NULL,
  timezone     TEXT NOT NULL,
  lat          NUMERIC(9,6),
  lon          NUMERIC(9,6),
  slug_name    TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── stations (optional, for observation audit) ─────────────────────────────
CREATE TABLE IF NOT EXISTS stations (
  station_id TEXT PRIMARY KEY,
  city_id    TEXT REFERENCES cities(city_id),
  provider   TEXT NOT NULL,
  name       TEXT,
  lat        NUMERIC(9,6),
  lon        NUMERIC(9,6),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stations_city ON stations(city_id);

-- ─── events ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  event_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id               TEXT NOT NULL REFERENCES cities(city_id),
  metric                metric_type NOT NULL DEFAULT 'TMAX',
  event_date_local      DATE NOT NULL,
  timezone              TEXT NOT NULL,
  unit                  temp_unit NOT NULL,
  event_slug            TEXT NOT NULL,
  polymarket_event_id   TEXT,

  resolved_outcome_label TEXT,
  resolved_at            TIMESTAMPTZ,

  market_opened_at      TIMESTAMPTZ,
  market_closed_at      TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (city_id, event_date_local, metric)
);
CREATE INDEX IF NOT EXISTS idx_events_city_date ON events(city_id, event_date_local);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date_local);

-- ─── market_dim (SCD2 — one row per outcome bin version) ────────────────────
CREATE TABLE IF NOT EXISTS market_dim (
  market_dim_id BIGSERIAL PRIMARY KEY,
  market_id     TEXT NOT NULL,
  event_id      UUID NOT NULL REFERENCES events(event_id),

  bin_type      bin_type NOT NULL,
  bin_low       REAL,
  bin_high      REAL,
  label         TEXT NOT NULL,

  -- Token IDs for WebSocket / CLOB
  token_id_yes  TEXT,
  token_id_no   TEXT,
  condition_id  TEXT,

  -- SCD2
  valid_from    TIMESTAMPTZ NOT NULL,
  valid_to      TIMESTAMPTZ NOT NULL DEFAULT 'infinity',
  is_current    BOOLEAN NOT NULL DEFAULT true,

  UNIQUE (market_id, valid_from),

  CONSTRAINT chk_bin_bounds CHECK (
    (bin_type = 'RANGE' AND bin_low IS NOT NULL AND bin_high IS NOT NULL AND bin_low <= bin_high)
    OR (bin_type = 'GE'  AND bin_low IS NOT NULL AND bin_high IS NULL)
    OR (bin_type = 'LE'  AND bin_high IS NOT NULL AND bin_low IS NULL)
    OR (bin_type = 'EQ'  AND bin_low IS NOT NULL AND bin_high IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_market_dim_current
  ON market_dim(market_id) WHERE is_current = true;
CREATE INDEX IF NOT EXISTS idx_market_dim_event
  ON market_dim(event_id, is_current);

-- ─── event_orderbook_state (SCD2 with hash-based dedup) ─────────────────────
CREATE TABLE IF NOT EXISTS event_orderbook_state (
  state_id      BIGSERIAL PRIMARY KEY,
  event_id      UUID NOT NULL REFERENCES events(event_id),

  valid_from    TIMESTAMPTZ NOT NULL,
  valid_to      TIMESTAMPTZ NOT NULL DEFAULT 'infinity',
  is_current    BOOLEAN NOT NULL DEFAULT true,

  state_hash    BYTEA NOT NULL,

  mids_cents    SMALLINT[] NOT NULL,
  spreads_cents SMALLINT[],

  sum_bid_size  DOUBLE PRECISION,
  sum_ask_size  DOUBLE PRECISION,
  volume_24h    DOUBLE PRECISION,
  volume_total  DOUBLE PRECISION,
  open_interest DOUBLE PRECISION,

  UNIQUE (event_id, valid_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_eos_current
  ON event_orderbook_state(event_id) WHERE is_current = true;
CREATE INDEX IF NOT EXISTS idx_eos_event_ts
  ON event_orderbook_state(event_id, valid_from);

-- ─── event_heartbeat ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS event_heartbeat (
  event_id UUID NOT NULL REFERENCES events(event_id),
  ts       TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (event_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_heartbeat_event
  ON event_heartbeat(event_id, ts DESC);

-- ─── event_forecast_state (SCD2) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS event_forecast_state (
  forecast_state_id BIGSERIAL PRIMARY KEY,
  event_id          UUID NOT NULL REFERENCES events(event_id),

  valid_from        TIMESTAMPTZ NOT NULL,
  valid_to          TIMESTAMPTZ NOT NULL DEFAULT 'infinity',
  is_current        BOOLEAN NOT NULL DEFAULT true,

  forecast_hash     BYTEA NOT NULL,

  source            TEXT NOT NULL,
  model_run         TIMESTAMPTZ,
  horizon_hours     SMALLINT,

  t_point           NUMERIC(6,2) NOT NULL,
  t_p10             NUMERIC(6,2),
  t_p50             NUMERIC(6,2),
  t_p90             NUMERIC(6,2),

  unit              temp_unit NOT NULL,

  UNIQUE (event_id, valid_from),

  CONSTRAINT chk_quantiles CHECK (
    (t_p10 IS NULL AND t_p50 IS NULL AND t_p90 IS NULL)
    OR (t_p10 IS NOT NULL AND t_p50 IS NOT NULL AND t_p90 IS NOT NULL
        AND t_p10 <= t_p50 AND t_p50 <= t_p90)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_efs_current
  ON event_forecast_state(event_id) WHERE is_current = true;
CREATE INDEX IF NOT EXISTS idx_efs_event_ts
  ON event_forecast_state(event_id, valid_from);

-- ─── market_open_context ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS market_open_context (
  event_id                   UUID PRIMARY KEY REFERENCES events(event_id) ON DELETE CASCADE,
  opened_at                  TIMESTAMPTZ NOT NULL,
  initial_forecast_state_id  BIGINT REFERENCES event_forecast_state(forecast_state_id),
  initial_orderbook_state_id BIGINT REFERENCES event_orderbook_state(state_id),
  initial_volume             DOUBLE PRECISION,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── observations (ground truth) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS observations (
  city_id        TEXT NOT NULL REFERENCES cities(city_id) ON DELETE CASCADE,
  station_id     TEXT REFERENCES stations(station_id),
  obs_timestamp  TIMESTAMPTZ NOT NULL,
  obs_date_local DATE NOT NULL,
  metric         metric_type NOT NULL DEFAULT 'TMAX',
  unit           temp_unit NOT NULL,
  value          NUMERIC(6,2) NOT NULL,
  source         TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (city_id, obs_date_local, metric, source)
);
CREATE INDEX IF NOT EXISTS idx_obs_city_date ON observations(city_id, obs_date_local);

-- ─── trades (future use) ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trades (
  trade_id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  timestamp                   TIMESTAMPTZ NOT NULL,
  event_id                    UUID NOT NULL REFERENCES events(event_id),
  market_id                   TEXT NOT NULL,
  outcome                     pm_outcome NOT NULL,
  side                        trade_side NOT NULL,
  order_type                  order_type NOT NULL,
  limit_price                 NUMERIC(6,4),
  fill_price                  NUMERIC(6,4) NOT NULL,
  shares                      NUMERIC(20,6) NOT NULL,
  fees                        NUMERIC(20,6),
  signal_orderbook_state_id   BIGINT REFERENCES event_orderbook_state(state_id),
  signal_forecast_state_id    BIGINT REFERENCES event_forecast_state(forecast_state_id),
  strategy_tag                TEXT,
  external_order_id           TEXT,
  notes                       TEXT
);
CREATE INDEX IF NOT EXISTS idx_trades_event_ts ON trades(event_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy_tag);

-- ─── observations_intraday (SCD2-like, temperature at time of reading) ──────
CREATE TABLE IF NOT EXISTS observations_intraday (
  obs_id         BIGSERIAL PRIMARY KEY,
  city_id        TEXT NOT NULL REFERENCES cities(city_id),
  station_id     TEXT REFERENCES stations(station_id),

  -- SCD2-like
  valid_from     TIMESTAMPTZ NOT NULL,
  valid_to       TIMESTAMPTZ NOT NULL DEFAULT 'infinity',
  is_current     BOOLEAN NOT NULL DEFAULT true,

  obs_date_local DATE NOT NULL,
  metric         metric_type NOT NULL DEFAULT 'TOBS',
  unit           temp_unit NOT NULL,
  value          NUMERIC(6,2) NOT NULL,
  source         TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (city_id, valid_from, metric)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_obs_intraday_current
  ON observations_intraday(city_id, metric) WHERE is_current = true;
CREATE INDEX IF NOT EXISTS idx_obs_intraday_city_date
  ON observations_intraday(city_id, obs_date_local);
CREATE INDEX IF NOT EXISTS idx_obs_intraday_ts
  ON observations_intraday(city_id, valid_from DESC);
