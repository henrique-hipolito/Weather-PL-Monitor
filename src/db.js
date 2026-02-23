'use strict';

const { Pool } = require('pg');
const logger = require('./utils/logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'Unexpected idle client error');
});

/**
 * Run a callback inside a checked-out client (for transactions).
 * Automatically releases the client when done.
 */
async function withClient(fn) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/**
 * Simple query shortcut on the pool.
 */
async function query(text, params) {
  return pool.query(text, params);
}

/**
 * Run schema.sql and seed.sql idempotently.
 */
async function initDatabase() {
  const fs = require('fs');
  const path = require('path');

  const schemaPath = path.join(__dirname, 'schema.sql');
  const seedPath = path.join(__dirname, 'seed.sql');

  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  const seedSql = fs.readFileSync(seedPath, 'utf8');

  logger.info('Running schema.sql ...');
  await pool.query(schemaSql);

  logger.info('Running seed.sql ...');
  await pool.query(seedSql);

  logger.info('Database initialized');
}

/**
 * Graceful shutdown — drain the pool.
 */
async function close() {
  logger.info('Closing database pool ...');
  await pool.end();
}

module.exports = { pool, query, withClient, initDatabase, close };
