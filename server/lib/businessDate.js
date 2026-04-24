'use strict';
const { DateTime } = require('luxon');

const TZ = 'Asia/Kolkata';
const CUTOFF_HOURS = 5;
const CUTOFF_MIN = 30;

function businessDate(ts) {
  const millis = ts == null ? Date.now() : (ts instanceof Date ? ts.getTime() : (typeof ts === 'number' ? ts : Date.parse(ts)));
  if (!millis || isNaN(millis)) return null;
  const d = DateTime.fromMillis(millis, { zone: TZ }).minus({ hours: CUTOFF_HOURS, minutes: CUTOFF_MIN });
  return d.toISODate();
}

function currentBusinessDate() {
  return businessDate(Date.now());
}

module.exports = { businessDate, currentBusinessDate, TZ };
