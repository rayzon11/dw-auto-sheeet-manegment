'use strict';
// Live Google Sheets writer — uses the same sheetMap as the xlsx writer.
// Setup (one-time):
//   1. Google Cloud Console → new project → enable "Google Sheets API".
//   2. Create a Service Account → key JSON (download).
//   3. Share your target Google Sheet with the service account's email (editor).
//   4. Set env:
//        GOOGLE_SERVICE_ACCOUNT_JSON = <absolute path to key.json>
//        GOOGLE_SHEET_ID            = <sheet id from its URL>
//        GOOGLE_SHEET_TAB           = DEMO  (default)
//
// This module is loaded lazily — if googleapis isn't installed or creds aren't set,
// routes that call it will 501 gracefully.

const { buildDataForDate } = require('./xlsxWriter');
const M = require('./sheetMap');

// Read settings either from env vars OR from the `settings` table so the
// user can configure Google Sheets connection from the UI without restarting.
function loadGoogleConfig() {
  const { db } = require('./db');
  const get = (k) => {
    if (process.env[k]) return process.env[k];
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
    return row ? row.value : null;
  };
  return {
    sheetId: get('GOOGLE_SHEET_ID'),
    tab: get('GOOGLE_SHEET_TAB') || 'DEMO',
    saJson: get('GOOGLE_SERVICE_ACCOUNT_JSON'), // path OR raw JSON string
  };
}

let _sheets = null;
let _sheetsKey = '';
async function sheetsClient() {
  const cfg = loadGoogleConfig();
  if (!cfg.saJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not set (env or settings table)');
  // Cache invalidates if the credential changes
  if (_sheets && _sheetsKey === cfg.saJson) return _sheets;
  const { google } = require('googleapis');
  const fs = require('fs');
  let credentials = null;
  let keyFile = null;
  if (cfg.saJson.trim().startsWith('{')) {
    credentials = JSON.parse(cfg.saJson);
  } else if (fs.existsSync(cfg.saJson)) {
    keyFile = cfg.saJson;
  } else {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON: not a JSON string and not a file path');
  }
  const auth = new google.auth.GoogleAuth({
    ...(keyFile ? { keyFile } : { credentials }),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  _sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
  _sheetsKey = cfg.saJson;
  return _sheets;
}

// A1 helpers — convert 0-indexed (r, c) to "A1" style column letters.
function colLetter(c) {
  let s = '';
  c = Number(c);
  do { s = String.fromCharCode(65 + (c % 26)) + s; c = Math.floor(c / 26) - 1; } while (c >= 0);
  return s;
}
function a1(r, c) { return `${colLetter(c)}${r + 1}`; }
function rangeA1(r1, c1, r2, c2) { return `${a1(r1, c1)}:${a1(r2, c2)}`; }

// Build a single `values.batchUpdate` payload from the sheetMap-structured data.
function buildBatch(data, tab) {
  const reqs = [];
  const push = (r1, c1, values) => reqs.push({
    range: `'${tab}'!${rangeA1(r1, c1, r1 + values.length - 1, c1 + values[0].length - 1)}`,
    values,
  });

  // ── banks: rows firstRow..firstRow+N, cols 0..7 (rewrite whole block) ──
  if (data.banks && data.banks.length) {
    const rows = data.banks.slice(0, M.BANK.lastRow - M.BANK.firstRow + 1).map((b, i) => [
      i + 1, b.name || '', b.holder || '',
      Number(b.open) || 0, Number(b.credit) || 0, '', Number(b.debit) || 0,
      Number(b.closing) || 0,
    ]);
    push(M.BANK.firstRow, 0, rows);
  }

  // ── panels: each 3-col block (deposit, freeChips, withdrawal) ──
  if (data.panels) {
    M.PANELS.forEach((p, pi) => {
      const pd = data.panels[p.slug]; if (!pd) return;
      const entries = pd.entries || [];
      if (entries.length) {
        const values = entries.map(e => [
          Number(e.deposit) || 0, Number(e.freeChips) || 0, Number(e.withdrawal) || 0,
        ]);
        push(M.PANEL_FIRST_ROW, p.col, values);
      }
      // DW summary
      push(M.DW_SUMMARY.firstRow + pi, M.DW_SUMMARY.cols.totalDeposit, [[
        Number(pd.totalDeposit) || 0, Number(pd.totalWithdrawal) || 0,
        (Number(pd.totalDeposit) || 0) - (Number(pd.totalWithdrawal) || 0),
      ]]);
      // Chips summary
      push(M.CHIPS_SUMMARY.firstRow + pi, M.CHIPS_SUMMARY.cols.openChips, [[
        Number(pd.openChips) || 0, Number(pd.closeChips) || 0,
        (Number(pd.closeChips) || 0) - (Number(pd.openChips) || 0),
      ]]);
    });
  }

  // ── bank & exp ledger ──
  const writeLedger = (block, rows, hasSr) => {
    if (!rows.length) return;
    const values = rows.slice(0, block.lastRow - block.firstRow + 1).map((row, i) => {
      const arr = new Array(Math.max(block.cols.debitDetails, block.cols.creditDetails) + 1).fill('');
      if (hasSr) arr[block.cols.sr] = i + 1;
      if (Number(row.credit)) { arr[block.cols.credit] = Number(row.credit); arr[block.cols.creditDetails] = row.creditDetails || ''; }
      if (Number(row.debit))  { arr[block.cols.debit]  = Number(row.debit);  arr[block.cols.debitDetails]  = row.debitDetails  || ''; }
      return arr;
    });
    push(block.firstRow, 0, values);
  };
  writeLedger(M.BANK_EXP,  data.bankExp || [], true);
  writeLedger(M.PARKING,   data.parking || [], false);

  return reqs;
}

async function pushToGoogleSheet(db, business_date) {
  const cfg = loadGoogleConfig();
  const sheetId = cfg.sheetId;
  const tab = cfg.tab;
  if (!sheetId) throw new Error('GOOGLE_SHEET_ID not set (env or settings table)');
  const svc = await sheetsClient();
  const data = buildDataForDate(db, business_date);
  const reqs = buildBatch(data, tab);
  if (!reqs.length) return { updated: 0 };
  const resp = await svc.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { valueInputOption: 'RAW', data: reqs },
  });
  return {
    updated: resp.data.totalUpdatedCells || 0,
    ranges: reqs.length,
    sheetId, tab, url: `https://docs.google.com/spreadsheets/d/${sheetId}`,
  };
}

// Debounced live sync: fire-and-forget. Coalesces bursts of mutations
// (e.g. bulk imports) into one push per ~3 seconds per business_date.
const _pending = new Map(); // date -> timer
function scheduleLiveSync(business_date) {
  try {
    const cfg = loadGoogleConfig();
    if (!cfg.sheetId || !cfg.saJson) return; // not configured — skip silently
    if (_pending.has(business_date)) return;
    const t = setTimeout(async () => {
      _pending.delete(business_date);
      try {
        const { db } = require('./db');
        const r = await pushToGoogleSheet(db, business_date);
        console.log('[gsync]', business_date, r);
      } catch (e) {
        console.error('[gsync] error', business_date, e.message);
      }
    }, 3000);
    _pending.set(business_date, t);
  } catch (_) {}
}

module.exports = { pushToGoogleSheet, buildBatch, a1, rangeA1, loadGoogleConfig, scheduleLiveSync };
