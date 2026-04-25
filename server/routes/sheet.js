'use strict';
// Sheet export / upload routes.
// - POST /api/sheet/template   — upload the master .xlsx template (admin only)
// - GET  /api/sheet/xlsx?date= — download a filled .xlsx for a business_date
// - POST /api/sheet/google     — push selected rows to Google Sheets (stub; requires GS_* env)

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { db, audit } = require('../lib/db');
const A = require('../lib/auth');
const { currentBusinessDate } = require('../lib/businessDate');
const { writeWorkbook, buildDataForDate, buildGrid, loadTemplateStyles } = require('../lib/xlsxWriter');

const router = express.Router();
const TEMPLATE_DIR = path.join(__dirname, '..', '..', 'data', 'templates');
const OUT_DIR = path.join(__dirname, '..', '..', 'data', 'exports');
fs.mkdirSync(TEMPLATE_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

function getTemplatePath() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'sheet_template_path'").get();
  return row ? row.value : null;
}

router.post('/template', A.requireAuth, A.requireAdmin, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'no file' });
  const dest = path.join(TEMPLATE_DIR, 'master.xlsx');
  fs.writeFileSync(dest, req.file.buffer);
  db.prepare(
    `INSERT INTO settings(key, value) VALUES ('sheet_template_path', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(dest);
  audit(req.user.id, 'upload', 'sheet_template', null, { bytes: req.file.buffer.length });
  res.json({ ok: true, path: dest });
});

router.get('/xlsx', A.requireAuth, (req, res) => {
  const date = req.query.date || currentBusinessDate();
  const tpl = getTemplatePath();
  if (!tpl || !fs.existsSync(tpl)) {
    return res.status(400).json({ ok: false, error: 'no template uploaded — POST /api/sheet/template first' });
  }
  try {
    const data = buildDataForDate(db, date);
    const out = path.join(OUT_DIR, `hisab_${date}.xlsx`);
    writeWorkbook(tpl, out, data);
    res.download(out, `hisab_${date}.xlsx`);
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

router.get('/preview', A.requireAuth, (req, res) => {
  const date = req.query.date || currentBusinessDate();
  try {
    const data = buildDataForDate(db, date);
    // Flatten into a per-row list the UI can checkbox
    const rows = [];
    for (const [slug, pd] of Object.entries(data.panels)) {
      for (const e of pd.entries) {
        if (e.deposit)    rows.push({ kind: 'panel_deposit',    panel: slug, name: e.name, amt: e.deposit, selected: true });
        if (e.withdrawal) rows.push({ kind: 'panel_withdrawal', panel: slug, name: e.name, amt: e.withdrawal, selected: true });
        if (e.freeChips)  rows.push({ kind: 'panel_free_chips', panel: slug, name: e.name, amt: e.freeChips, selected: true });
      }
    }
    for (const b of data.banks) {
      if (b.credit) rows.push({ kind: 'bank_credit', bank: b.name, amt: b.credit, selected: true });
      if (b.debit)  rows.push({ kind: 'bank_debit',  bank: b.name, amt: b.debit,  selected: true });
    }
    for (const r of data.bankExp) rows.push({ kind: 'bank_exp', ...r, selected: true });
    for (const r of data.parking) rows.push({ kind: 'parking', ...r, selected: true });
    res.json({ ok: true, business_date: date, rows, counts: {
      banks: data.banks.length,
      panels: Object.keys(data.panels).length,
      bankExp: data.bankExp.length,
      parking: data.parking.length,
    } });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

router.post('/google', A.requireAuth, async (req, res) => {
  if (!process.env.GOOGLE_SHEET_ID || !process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return res.status(400).json({ ok: false, error:
      'set GOOGLE_SHEET_ID + GOOGLE_SERVICE_ACCOUNT_JSON env vars, and share the sheet with the service account email' });
  }
  try {
    const { pushToGoogleSheet } = require('../lib/googleSheetWriter');
    const date = req.body?.date || req.query.date || currentBusinessDate();
    const result = await pushToGoogleSheet(db, date);
    audit(req.user.id, 'export', 'google_sheet', null, result);
    res.json({ ok: true, date, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// List every date that has at least one entry — for the admin's history picker.
router.get('/dates', A.requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT d AS business_date, SUM(cnt) AS entries FROM (
      SELECT business_date AS d, COUNT(*) AS cnt FROM bank_txns GROUP BY business_date
      UNION ALL SELECT business_date, COUNT(*) FROM dw GROUP BY business_date
      UNION ALL SELECT business_date, COUNT(*) FROM gpay GROUP BY business_date
      UNION ALL SELECT business_date, COUNT(*) FROM expenses GROUP BY business_date
    ) GROUP BY d ORDER BY d DESC
  `).all();
  res.json({ ok: true, rows });
});

// Rollover status — UI uses this for the countdown banner.
router.get('/rollover/status', A.requireAuth, (req, res) => {
  const { nextRolloverInfo, currentBusinessDate } = require('../lib/businessDate');
  const last = db.prepare("SELECT value FROM settings WHERE key = 'last_rollover'").get();
  const lastDate = db.prepare("SELECT value FROM settings WHERE key = 'last_rollover_date'").get();
  const info = nextRolloverInfo();
  res.json({ ok: true,
    current_business_date: currentBusinessDate(),
    next_in: info.hms,
    next_ms: info.ms,
    next_business_date: info.nextBusinessDate,
    last_rollover_ts: last ? last.value : null,
    last_rollover_date: lastDate ? lastDate.value : null,
  });
});

// Force a rollover now (admin). Useful to trigger the archive snapshot manually.
router.post('/rollover/run', A.requireAuth, A.requireAdmin, async (req, res) => {
  try {
    const info = await require('../lib/rollover').runRollover('manual');
    audit(req.user.id, 'rollover', 'manual', null, info);
    res.json({ ok: true, info });
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

// Reset (wipe) all entries for a specific business_date. Admin-only, audited.
router.post('/reset', A.requireAuth, A.requireAdmin, (req, res) => {
  const { date, confirm } = req.body || {};
  if (!date || confirm !== date) {
    return res.status(400).json({ ok: false, error: 'pass { date, confirm: <same date> }' });
  }
  const r1 = db.prepare('DELETE FROM bank_txns WHERE business_date = ?').run(date);
  const r2 = db.prepare('DELETE FROM dw WHERE business_date = ?').run(date);
  const r3 = db.prepare('DELETE FROM gpay WHERE business_date = ?').run(date);
  const r4 = db.prepare('DELETE FROM expenses WHERE business_date = ?').run(date);
  const deleted = { bank_txns: r1.changes, dw: r2.changes, gpay: r3.changes, expenses: r4.changes };
  audit(req.user.id, 'reset', 'business_date', null, { date, deleted });
  res.json({ ok: true, date, deleted });
});

// Inline edit of a single bank's opening balance (admin control).
router.post('/banks/:id/open', A.requireAuth, A.requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const amt = Number(req.body?.open_balance);
  if (!id || !Number.isFinite(amt)) return res.status(400).json({ ok: false, error: 'bad id/amt' });
  db.prepare('UPDATE banks SET open_balance = ? WHERE id = ?').run(amt, id);
  audit(req.user.id, 'update', 'bank_open_balance', id, { open_balance: amt });
  res.json({ ok: true });
});

// Live 2D grid for the Google-Sheets-style viewer in the web app.
router.get('/grid', A.requireAuth, (req, res) => {
  const date = req.query.date || currentBusinessDate();
  try {
    const data = buildDataForDate(db, date);
    const g = buildGrid(data);
    const tpl = getTemplatePath();
    const styles = tpl ? loadTemplateStyles(tpl) : { colors: [], fontColors: [], merges: [], colWidths: [] };
    // Layer manual overrides on top of computed cells
    const ovs = db.prepare('SELECT row, col, value FROM sheet_overrides WHERE business_date = ?').all(date);
    const overrides = {};
    for (const o of ovs) {
      overrides[`${o.row},${o.col}`] = o.value;
      if (g.grid[o.row]) {
        const num = Number(o.value);
        g.grid[o.row][o.col] = (o.value !== '' && !isNaN(num) && /^-?\d+(\.\d+)?$/.test(String(o.value))) ? num : o.value;
      }
    }
    res.json({ ok: true, business_date: date,
      grid: g.grid, rows: g.rows, cols: g.cols,
      colors: styles.colors, fontColors: styles.fontColors,
      merges: styles.merges, colWidths: styles.colWidths,
      overrides,
      generated_at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

router.get('/google/status', A.requireAuth, (req, res) => {
  res.json({
    ok: true,
    configured: !!(process.env.GOOGLE_SHEET_ID && process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
    sheet_id: process.env.GOOGLE_SHEET_ID || null,
    tab: process.env.GOOGLE_SHEET_TAB || 'DEMO',
    url: process.env.GOOGLE_SHEET_ID
      ? `https://docs.google.com/spreadsheets/d/${process.env.GOOGLE_SHEET_ID}` : null,
  });
});

// Manual cell write — used by the Live Sheet contenteditable cells.
// Body: { date, row, col, value }   (value '' or null clears the override)
router.post('/cell', A.requireAuth, (req, res) => {
  const { date, row, col, value } = req.body || {};
  if (!date || !Number.isInteger(row) || !Number.isInteger(col)) {
    return res.status(400).json({ ok: false, error: 'date, row, col required' });
  }
  if (value === '' || value === null || value === undefined) {
    db.prepare('DELETE FROM sheet_overrides WHERE business_date=? AND row=? AND col=?').run(date, row, col);
  } else {
    db.prepare(`INSERT INTO sheet_overrides(business_date,row,col,value,updated_by,updated_at)
                VALUES (?,?,?,?,?,datetime('now'))
                ON CONFLICT(business_date,row,col) DO UPDATE SET
                  value=excluded.value, updated_by=excluded.updated_by, updated_at=excluded.updated_at`)
      .run(date, row, col, String(value), req.user.id);
  }
  audit(req.user.id, 'cell_write', 'sheet', null, { date, row, col, value });
  res.json({ ok: true });
});

module.exports = router;
