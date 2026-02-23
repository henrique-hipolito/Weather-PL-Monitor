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

module.exports = { recordHeartbeat };
