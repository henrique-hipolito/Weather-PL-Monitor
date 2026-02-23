'use strict';

const config = require('./config');
const db = require('./db');
const logger = require('./utils/logger');
const { sleep } = require('./utils/retry');
const { discoverMarkets } = require('./polymarket/marketSync');
const { pollBooks } = require('./collector/bookPoller');
const { syncForecasts } = require('./weather/forecastSync');
const { syncObservations } = require('./weather/observationSync');
const { checkAndSyncTmax } = require('./weather/tmaxSync');
const { pruneHeartbeats } = require('./collector/heartbeat');
const { sendTelegram } = require('./utils/telegram');

// ─── Graceful shutdown ──────────────────────────────────────────────────────

let shuttingDown = false;

function setupShutdownHandlers() {
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutdown signal received — draining ...');

    // Give in-flight queries a moment to finish
    await sleep(2_000);
    await db.close();
    logger.info('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (err) => {
    logger.error({ err: err?.message || err }, 'Unhandled rejection');
  });

  process.on('uncaughtException', (err) => {
    logger.fatal({ err: err?.message || err }, 'Uncaught exception — exiting');
    process.exit(1);
  });
}

// ─── Loop runner ─────────────────────────────────────────────────────────────

/**
 * Run a function in an infinite loop with a fixed interval.
 * Catches all errors so the loop never dies.
 */
async function runLoop(name, fn, intervalMs) {
  logger.info({ loop: name, intervalMs }, 'Loop started');

  while (!shuttingDown) {
    const start = Date.now();
    try {
      await fn();
    } catch (err) {
      logger.error({ loop: name, err: err.message }, 'Loop iteration error (caught)');
    }

    const elapsed = Date.now() - start;
    const waitMs = Math.max(0, intervalMs - elapsed);

    if (waitMs > 0 && !shuttingDown) {
      await sleep(waitMs);
    }
  }

  logger.info({ loop: name }, 'Loop stopped (shutdown)');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  logger.info('='.repeat(60));
  logger.info('Polymarket Weather Bot starting');
  logger.info({
    cities: config.CITIES.map(c => c.city_id),
    pollIntervalMs: config.POLL_INTERVAL_MS,
    forecastIntervalMs: config.FORECAST_INTERVAL_MS,
    discoveryIntervalMs: config.MARKET_DISCOVERY_INTERVAL_MS,
    daysAhead: config.DAYS_AHEAD,
    nodeEnv: process.env.NODE_ENV || 'development',
  }, 'Configuration');
  logger.info('='.repeat(60));

  setupShutdownHandlers();

  // 1. Initialize database (schema + seed)
  await db.initDatabase();

  // 2. Run initial market discovery before starting loops
  logger.info('Running initial market discovery ...');
  await discoverMarkets();

  // 3. Run initial forecast sync
  logger.info('Running initial forecast sync ...');
  await syncForecasts();

  // 4. Start the three loops in parallel
  logger.info('Starting main loops ...');

  const loops = [
    runLoop('market-discovery',    discoverMarkets,  config.MARKET_DISCOVERY_INTERVAL_MS),
    runLoop('book-poller',         pollBooks,         config.POLL_INTERVAL_MS),
    runLoop('forecast-sync',       syncForecasts,     config.FORECAST_INTERVAL_MS),
    runLoop('observation-intraday', syncObservations, config.OBSERVATION_INTERVAL_MS),
    runLoop('tmax-daily',          checkAndSyncTmax,  config.TMAX_CHECK_INTERVAL_MS),
    runLoop('heartbeat-prune', async () => {
      const deleted = await pruneHeartbeats(7);
      if (deleted > 0) logger.info({ deleted }, 'Pruned old heartbeats');
    }, 24 * 60 * 60_000),  // 24h
    runLoop('heartbeat-telegram', async () => {
      await sendTelegram(
        `✅ <b>Weather Bot</b> — alive\n` +
        `🕐 ${new Date().toISOString()}`
      );
    }, 12 * 60 * 60_000), // 12 horas
  ];

  // Wait forever (or until shutdown)
  await Promise.all(loops);
}

// ─── Entrypoint ──────────────────────────────────────────────────────────────

main().catch((err) => {
  logger.fatal({ err: err.message }, 'Fatal error during startup');
  process.exit(1);
});
