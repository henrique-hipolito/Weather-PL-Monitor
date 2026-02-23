'use strict';

const { slugDateParts } = require('../utils/timezone');

/**
 * Build a Polymarket event slug for a city and local date.
 *
 * @param {string} citySlugName - e.g. 'nyc', 'sao-paulo', 'buenos-aires'
 * @param {import('luxon').DateTime} dt - Luxon DateTime in city's local tz
 * @returns {string} e.g. 'highest-temperature-in-sao-paulo-on-february-23-2026'
 */
function buildEventSlug(citySlugName, dt) {
  const { month, day, year } = slugDateParts(dt);
  return `highest-temperature-in-${citySlugName}-on-${month}-${day}-${year}`;
}

/**
 * Build the full Polymarket URL for an event.
 */
function buildEventUrl(citySlugName, dt) {
  return `https://polymarket.com/event/${buildEventSlug(citySlugName, dt)}`;
}

module.exports = { buildEventSlug, buildEventUrl };
