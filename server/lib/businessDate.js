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

// How many milliseconds remain until the next 05:30 IST rollover.
function msUntilNextRollover(now = Date.now()) {
  const t = DateTime.fromMillis(now, { zone: TZ });
  let target = t.set({ hour: CUTOFF_HOURS, minute: CUTOFF_MIN, second: 0, millisecond: 0 });
  if (target <= t) target = target.plus({ days: 1 });
  return target.toMillis() - now;
}

// Human-readable next-rollover label (HH:MM:SS countdown + target date).
function nextRolloverInfo(now = Date.now()) {
  const ms = msUntilNextRollover(now);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const nextBusinessDate = businessDate(now + ms + 1000);
  return { ms, hms: `${h}h ${m}m ${s}s`, nextBusinessDate };
}

module.exports = { businessDate, currentBusinessDate, msUntilNextRollover, nextRolloverInfo, TZ };
