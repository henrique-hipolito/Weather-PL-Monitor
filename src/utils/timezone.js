'use strict';

const { DateTime } = require('luxon');

/**
 * Get "today" in a city's local timezone.
 * Returns a Luxon DateTime at start-of-day in the city's tz.
 */
function localToday(timezone) {
  return DateTime.now().setZone(timezone).startOf('day');
}

/**
 * Get an array of target dates for a city (today, tomorrow, ..., up to daysAhead).
 * Each element is { dateLocal: 'YYYY-MM-DD', dt: Luxon DateTime }.
 */
function targetDates(timezone, daysAhead) {
  const today = localToday(timezone);
  const dates = [];
  for (let i = 0; i <= daysAhead; i++) {
    const dt = today.plus({ days: i });
    dates.push({
      dateLocal: dt.toISODate(),          // 'YYYY-MM-DD'
      dt,
    });
  }
  return dates;
}

/**
 * Build the month-day-year portion for a Polymarket slug from a local date.
 * e.g. { month: 'february', day: 23, year: 2026 }
 */
function slugDateParts(dt) {
  const MONTHS = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ];
  return {
    month: MONTHS[dt.month - 1],   // luxon months are 1-based
    day: dt.day,
    year: dt.year,
  };
}

/**
 * Convert a UTC Date to a local date string (YYYY-MM-DD) in the given timezone.
 */
function utcToLocalDate(utcDate, timezone) {
  return DateTime.fromJSDate(utcDate, { zone: 'utc' })
    .setZone(timezone)
    .toISODate();
}

/**
 * Compute horizon in hours from now to a target local date's end-of-day.
 */
function hoursUntilEndOfDay(targetDateLocal, timezone) {
  const endOfTarget = DateTime.fromISO(targetDateLocal, { zone: timezone }).endOf('day');
  const now = DateTime.now().setZone(timezone);
  return Math.max(0, Math.round(endOfTarget.diff(now, 'hours').hours));
}

module.exports = {
  localToday,
  targetDates,
  slugDateParts,
  utcToLocalDate,
  hoursUntilEndOfDay,
};
