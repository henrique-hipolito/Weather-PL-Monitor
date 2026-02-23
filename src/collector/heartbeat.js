'use strict';

const db = require('../db');

/**
 * Record a heartbeat for an event (proof that polling happened).
 */
async function recordHeartbeat(eventId) {
  await db.query(
    `INSERT INTO event_heartbeat (event_id, ts) VALUES ($1, now())`,
    [eventId],
  );
}

/**
 * Delete heartbeats older than the given number of days.
 */
async function pruneHeartbeats(retentionDays = 7) {
  const result = await db.query(
    `DELETE FROM event_heartbeat WHERE ts < now() - make_interval(days => $1)`,
    [retentionDays],
  );
  return result.rowCount;
}

module.exports = { recordHeartbeat, pruneHeartbeats };
