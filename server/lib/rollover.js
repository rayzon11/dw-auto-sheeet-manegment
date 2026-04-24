'use strict';
// 05:30 IST auto-rollover scheduler.
// At each rollover:
//   1. Computes the just-closed business date.
//   2. Writes a "last_rollover" + "last_rollover_date" into settings (UI reads this).
//   3. Archives a filled .xlsx snapshot of that date into data/exports/.
//   4. Optionally pushes the closed-day snapshot to Google Sheets (if configured).
// The rollover does NOT mutate any prior-date data — it just marks the boundary.

const fs = require('fs');
const path = require('path');
const { db } = require('./db');
const { businessDate, msUntilNextRollover, currentBusinessDate } = require('./businessDate');

const EXPORTS_DIR = path.join(__dirname, '..', '..', 'data', 'exports');
fs.mkdirSync(EXPORTS_DIR, { recursive: true });

function getTemplatePath() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'sheet_template_path'").get();
  return row ? row.value : null;
}

async function runRollover(reason = 'scheduled') {
  const closedDate = businessDate(Date.now() - 1000); // the date that just ended
  const newDate = currentBusinessDate();
  const ts = new Date().toISOString();
  const info = { reason, closedDate, newDate, ts };

  try {
    const { writeWorkbook, buildDataForDate } = require('./xlsxWriter');
    const tpl = getTemplatePath();
    if (tpl && fs.existsSync(tpl)) {
      const out = path.join(EXPORTS_DIR, `hisab_${closedDate}.xlsx`);
      writeWorkbook(tpl, out, buildDataForDate(db, closedDate));
      info.archived = out;
    }
  } catch (e) { info.archive_error = String(e.message || e); }

  // Best-effort push to Google Sheets for the closed date
  try {
    if (process.env.GOOGLE_SHEET_ID && process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      const { pushToGoogleSheet } = require('./googleSheetWriter');
      const gs = await pushToGoogleSheet(db, closedDate);
      info.google = gs;
    }
  } catch (e) { info.google_error = String(e.message || e); }

  const upsert = db.prepare(
    `INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  );
  upsert.run('last_rollover', ts);
  upsert.run('last_rollover_date', closedDate);
  upsert.run('last_rollover_info', JSON.stringify(info));

  console.log('[rollover]', info);
  return info;
}

let timer = null;
function scheduleNext() {
  if (timer) clearTimeout(timer);
  const ms = msUntilNextRollover();
  timer = setTimeout(async () => {
    try { await runRollover('scheduled'); } catch (e) { console.error('[rollover] error', e); }
    // add a tiny drift guard, then reschedule
    setTimeout(scheduleNext, 2000);
  }, ms + 500);
  console.log('[rollover] next in', Math.round(ms / 1000), 's');
}

function start() {
  scheduleNext();
}

module.exports = { start, runRollover, scheduleNext };
