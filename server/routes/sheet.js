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
const { writeWorkbook, buildDataForDate, buildGrid } = require('../lib/xlsxWriter');

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

// Live 2D grid for the Google-Sheets-style viewer in the web app.
router.get('/grid', A.requireAuth, (req, res) => {
  const date = req.query.date || currentBusinessDate();
  try {
    const data = buildDataForDate(db, date);
    const g = buildGrid(data);
    res.json({ ok: true, business_date: date, grid: g.grid, rows: g.rows, cols: g.cols, generated_at: new Date().toISOString() });
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

module.exports = router;
