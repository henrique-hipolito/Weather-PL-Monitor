'use strict';

const config = require('../config');
const logger = require('./logger');

// ─── Circuit Breaker ─────────────────────────────────────────────────────────
// Per-key tracker: { failures: number, openUntil: number (epoch ms) }
const breakers = new Map();

function getBreaker(key) {
  if (!breakers.has(key)) {
    breakers.set(key, { failures: 0, openUntil: 0 });
  }
  return breakers.get(key);
}

function isCircuitOpen(key) {
  const b = getBreaker(key);
  if (b.openUntil === 0) return false;
  if (Date.now() >= b.openUntil) {
    // Cooldown elapsed — half-open, allow a retry
    b.openUntil = 0;
    b.failures = 0;
    return false;
  }
  return true;
}

function recordSuccess(key) {
  const b = getBreaker(key);
  b.failures = 0;
  b.openUntil = 0;
}

function recordFailure(key) {
  const b = getBreaker(key);
  b.failures += 1;
  if (b.failures >= config.CIRCUIT_BREAKER_THRESHOLD) {
    b.openUntil = Date.now() + config.CIRCUIT_BREAKER_COOLDOWN_MS;
    logger.warn({ key, cooldownMs: config.CIRCUIT_BREAKER_COOLDOWN_MS },
      'Circuit breaker OPEN — pausing requests');
  }
}

// ─── Retry with Exponential Backoff ──────────────────────────────────────────

/**
 * Execute `fn` with retry logic.
 *
 * @param {Function} fn          - Async function to execute.
 * @param {Object}   opts
 * @param {string}   opts.label  - Human-readable label for logs.
 * @param {string}   opts.circuitKey - Circuit breaker key (e.g. 'polymarket', 'nws').
 * @param {boolean}  opts.retryOn404 - Whether to retry on 404 (default: false).
 * @param {number}   opts.maxRetries - Override max retries.
 * @returns {*} Result of fn()
 */
async function withRetry(fn, opts = {}) {
  const {
    label = 'unknown',
    circuitKey,
    retryOn404 = false,
    maxRetries = config.MAX_RETRIES,
  } = opts;

  // Check circuit breaker
  if (circuitKey && isCircuitOpen(circuitKey)) {
    const b = getBreaker(circuitKey);
    const remainSec = Math.round((b.openUntil - Date.now()) / 1000);
    logger.warn({ label, circuitKey, remainSec }, 'Circuit open — skipping');
    return null;
  }

  let lastError;
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const result = await fn();
      if (circuitKey) recordSuccess(circuitKey);
      return result;
    } catch (err) {
      lastError = err;
      const status = err.status || err.statusCode || err.response?.status;

      // Don't retry 404 unless explicitly asked
      if (status === 404 && !retryOn404) {
        logger.debug({ label, status }, '404 — not retrying');
        if (circuitKey) recordSuccess(circuitKey); // 404 is not an infra failure
        return null;
      }

      // Don't retry 4xx client errors (except 429)
      if (status && status >= 400 && status < 500 && status !== 429) {
        logger.warn({ label, status, err: err.message }, 'Client error — not retrying');
        return null;
      }

      if (attempt <= maxRetries) {
        const delay = Math.min(
          config.RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1),
          config.RETRY_MAX_DELAY_MS,
        );
        const jitter = Math.random() * delay * 0.3;
        const totalDelay = Math.round(delay + jitter);
        logger.warn({ label, attempt, maxRetries, delayMs: totalDelay, err: err.message },
          'Retrying ...');
        await sleep(totalDelay);
      }
    }
  }

  // All retries exhausted
  if (circuitKey) recordFailure(circuitKey);
  logger.error({ label, err: lastError?.message }, 'All retries exhausted');
  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Rate Limiter (token bucket) ─────────────────────────────────────────────

class RateLimiter {
  constructor(rps) {
    this.interval = 1000 / rps;
    this.lastCall = 0;
  }

  async wait() {
    const now = Date.now();
    const elapsed = now - this.lastCall;
    if (elapsed < this.interval) {
      await sleep(this.interval - elapsed);
    }
    this.lastCall = Date.now();
  }
}

module.exports = { withRetry, sleep, RateLimiter };
