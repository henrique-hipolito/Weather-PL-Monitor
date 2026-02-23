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

async function pruneHeartbeats(daysToKeep = 7) {
  const result = await db.query(
    `DELETE FROM event_heartbeat WHERE ts < now() - ($1 || ' days')::interval`,
    [daysToKeep],
  );
  return result.rowCount;
}

module.exports = { recordHeartbeat, pruneHeartbeats };