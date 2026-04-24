'use strict';
// Write hisab entries into a copy of the master DW SHEET (.xlsx).
// Reads an existing workbook, stamps cells using sheetMap coordinates,
// writes the output to a date-stamped file, returns the output path.

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const M = require('./sheetMap');

function addr(r, c) { return XLSX.utils.encode_cell({ r, c }); }

function writeCell(ws, r, c, value) {
  if (value === undefined || value === null || value === '') return;
  const a = addr(r, c);
  const isNum = typeof value === 'number' && Number.isFinite(value);
  ws[a] = isNum ? { t: 'n', v: value } : { t: 's', v: String(value) };
  // extend !ref if needed
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  if (r > range.e.r) range.e.r = r;
  if (c > range.e.c) range.e.c = c;
  ws['!ref'] = XLSX.utils.encode_range(range);
}

// data shape:
// {
//   banks: [{ sr, name, holder, open, credit, debit, closing }],
//   panels: { '1XBET0001': { entries: [{name, deposit, freeChips, withdrawal}], openChips, closeChips, totalDeposit, totalWithdrawal }, ... },
//   bankExp: [{ credit, creditDetails, debit, debitDetails }],   // ordered rows
//   parking: [{ credit, creditDetails, debit, debitDetails }],
// }
function writeWorkbook(templatePath, outputPath, data) {
  const wb = XLSX.readFile(templatePath, { cellStyles: true });
  const ws = wb.Sheets[wb.SheetNames[0]];

  // ── banks ──────────────────────────────────────────────────────
  if (Array.isArray(data.banks)) {
    for (let i = 0; i < data.banks.length; i++) {
      const r = M.BANK.firstRow + i;
      if (r > M.BANK.lastRow) break;
      const b = data.banks[i];
      writeCell(ws, r, M.BANK.cols.sr,     i + 1);
      writeCell(ws, r, M.BANK.cols.name,   b.name);
      writeCell(ws, r, M.BANK.cols.holder, b.holder);
      writeCell(ws, r, M.BANK.cols.open,   Number(b.open) || 0);
      writeCell(ws, r, M.BANK.cols.credit, Number(b.credit) || 0);
      writeCell(ws, r, M.BANK.cols.debit,  Number(b.debit) || 0);
      writeCell(ws, r, M.BANK.cols.closing, Number(b.closing) || 0);
    }
  }

  // ── panel entries + summaries ─────────────────────────────────
  if (data.panels) {
    M.PANELS.forEach((p, pi) => {
      const pd = data.panels[p.slug];
      if (!pd) return;
      const baseCol = p.col;
      const entries = pd.entries || [];
      for (let i = 0; i < entries.length; i++) {
        const r = M.PANEL_FIRST_ROW + i;
        if (r > M.PANEL_LAST_ROW) break;
        const e = entries[i];
        if (Number(e.deposit))    writeCell(ws, r, baseCol + M.PANEL_COL.deposit,    Number(e.deposit));
        if (Number(e.freeChips))  writeCell(ws, r, baseCol + M.PANEL_COL.freeChips,  Number(e.freeChips));
        if (Number(e.withdrawal)) writeCell(ws, r, baseCol + M.PANEL_COL.withdrawal, Number(e.withdrawal));
      }
      // DW summary row
      const sRow = M.DW_SUMMARY.firstRow + pi;
      writeCell(ws, sRow, M.DW_SUMMARY.cols.totalDeposit,    Number(pd.totalDeposit) || 0);
      writeCell(ws, sRow, M.DW_SUMMARY.cols.totalWithdrawal, Number(pd.totalWithdrawal) || 0);
      writeCell(ws, sRow, M.DW_SUMMARY.cols.diff,
        (Number(pd.totalDeposit) || 0) - (Number(pd.totalWithdrawal) || 0));
      // Chips summary row
      const cRow = M.CHIPS_SUMMARY.firstRow + pi;
      writeCell(ws, cRow, M.CHIPS_SUMMARY.cols.openChips,  Number(pd.openChips) || 0);
      writeCell(ws, cRow, M.CHIPS_SUMMARY.cols.closeChips, Number(pd.closeChips) || 0);
      writeCell(ws, cRow, M.CHIPS_SUMMARY.cols.diff,
        (Number(pd.closeChips) || 0) - (Number(pd.openChips) || 0));
    });
  }

  // ── bank & expense ledger ─────────────────────────────────────
  writeLedger(ws, M.BANK_EXP,  data.bankExp || [],  /* hasSr */ true);
  writeLedger(ws, M.PARKING,   data.parking || [],  /* hasSr */ false);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  XLSX.writeFile(wb, outputPath);
  return outputPath;
}

function writeLedger(ws, block, rows, hasSr) {
  for (let i = 0; i < rows.length; i++) {
    const r = block.firstRow + i;
    if (r > block.lastRow) break;
    const row = rows[i];
    if (hasSr) writeCell(ws, r, block.cols.sr, i + 1);
    if (Number(row.credit)) {
      writeCell(ws, r, block.cols.credit, Number(row.credit));
      writeCell(ws, r, block.cols.creditDetails, row.creditDetails || '');
    }
    if (Number(row.debit)) {
      writeCell(ws, r, block.cols.debit, Number(row.debit));
      writeCell(ws, r, block.cols.debitDetails, row.debitDetails || '');
    }
  }
}

// Build the `data` object from DB rows for a given business_date.
function buildDataForDate(db, business_date) {
  const banks = db.prepare('SELECT id, name, holder, open_balance AS open FROM banks ORDER BY id LIMIT 50').all();
  // Aggregate credit/debit per bank_id for the date. Bank charges are kept out
  // of the per-bank credit/debit totals here — they flow into the Bank & Exp ledger.
  const txns = db.prepare(`
    SELECT bank_id, type, SUM(amt) AS total
    FROM bank_txns
    WHERE business_date = ? AND (category IS NULL OR category != 'charge')
    GROUP BY bank_id, type
  `).all(business_date);
  const byBank = {};
  for (const t of txns) {
    const k = t.bank_id || 0;
    byBank[k] = byBank[k] || { credit: 0, debit: 0 };
    if (t.type === 'credit') byBank[k].credit = t.total;
    else byBank[k].debit = t.total;
  }
  const bankRows = banks.map(b => {
    const tx = byBank[b.id] || { credit: 0, debit: 0 };
    return { ...b, credit: tx.credit, debit: tx.debit, closing: (b.open || 0) + tx.credit - tx.debit };
  });

  // Panels — aggregate dw rows per panel_slug
  const dwRows = db.prepare(`
    SELECT panel_slug, type, name, amt FROM dw
    WHERE business_date = ? AND panel_slug IS NOT NULL ORDER BY id
  `).all(business_date);
  const panels = {};
  for (const p of M.PANELS) panels[p.slug] = { entries: [], totalDeposit: 0, totalWithdrawal: 0 };
  // group by name within panel
  const byPanelName = {};
  for (const r of dwRows) {
    const key = r.panel_slug + '|' + (r.name || '');
    byPanelName[key] = byPanelName[key] || { panel: r.panel_slug, name: r.name, deposit: 0, withdrawal: 0, freeChips: 0 };
    if (r.type === 'Deposit') byPanelName[key].deposit += r.amt;
    else if (r.type === 'Withdrawal') byPanelName[key].withdrawal += r.amt;
  }
  for (const k of Object.keys(byPanelName)) {
    const e = byPanelName[k];
    if (!panels[e.panel]) continue;
    panels[e.panel].entries.push(e);
    panels[e.panel].totalDeposit += e.deposit;
    panels[e.panel].totalWithdrawal += e.withdrawal;
  }

  // Bank/Exp ledger: bank_charge txns + expenses with category
  const charges = db.prepare(`
    SELECT amt, detail FROM bank_txns
    WHERE business_date = ? AND category = 'charge'
  `).all(business_date);
  const exps = db.prepare(`
    SELECT amt, category, remark, employee FROM expenses WHERE business_date = ?
  `).all(business_date);
  const bankExp = [];
  for (const c of charges) bankExp.push({ debit: c.amt, debitDetails: 'BANK CHG' });
  for (const e of exps) {
    const cat = M.CATEGORIES[e.category];
    if (!cat || cat.block !== 'BANK_EXP') continue;
    const side = cat.side;
    let label = cat.label;
    if (e.category === 'atm' && e.employee) label += ' (' + e.employee + ')';
    if (e.remark) label += ' - ' + e.remark;
    bankExp.push({ [side]: e.amt, [side + 'Details']: label });
  }

  const parking = [];
  for (const e of exps) {
    const cat = M.CATEGORIES[e.category];
    if (!cat || cat.block !== 'PARKING') continue;
    parking.push({ [cat.side]: e.amt, [cat.side + 'Details']: cat.label + (e.remark ? ' - ' + e.remark : '') });
  }

  return { banks: bankRows, panels, bankExp, parking };
}

// Render the same data as a 2D JS array [rows][cols] — used by the live
// Google-Sheets-like viewer in the web app. Mirrors writeWorkbook's layout.
function buildGrid(data) {
  const ROWS = Math.max(M.BANK.lastRow, M.PANEL_FIRST_ROW + 60, M.BANK_EXP.lastRow) + 2;
  const COLS = Math.max(...M.PANELS.map(p => p.col + 3), 14) + 1;
  const grid = Array.from({ length: ROWS }, () => Array(COLS).fill(''));
  const set = (r, c, v) => { if (v === undefined || v === null || v === '') return; grid[r][c] = v; };

  // Header labels
  set(0, M.BANK.cols.sr, 'Sr');
  set(0, M.BANK.cols.name, 'Bank');
  set(0, M.BANK.cols.holder, 'Holder');
  set(0, M.BANK.cols.open, 'Open');
  set(0, M.BANK.cols.credit, 'Credit');
  set(0, M.BANK.cols.debit, 'Debit');
  set(0, M.BANK.cols.closing, 'Closing');
  // Panel header row
  M.PANELS.forEach(p => {
    set(0, p.col + M.PANEL_COL.deposit, p.slug + ' DEP');
    set(0, p.col + M.PANEL_COL.freeChips, p.slug + ' FC');
    set(0, p.col + M.PANEL_COL.withdrawal, p.slug + ' WDL');
  });

  // Banks
  (data.banks || []).forEach((b, i) => {
    const r = M.BANK.firstRow + i;
    if (r > M.BANK.lastRow) return;
    set(r, M.BANK.cols.sr, i + 1);
    set(r, M.BANK.cols.name, b.name || '');
    set(r, M.BANK.cols.holder, b.holder || '');
    set(r, M.BANK.cols.open, Number(b.open) || 0);
    set(r, M.BANK.cols.credit, Number(b.credit) || 0);
    set(r, M.BANK.cols.debit, Number(b.debit) || 0);
    set(r, M.BANK.cols.closing, Number(b.closing) || 0);
  });

  // Panel entries + summaries
  if (data.panels) {
    M.PANELS.forEach((p, pi) => {
      const pd = data.panels[p.slug];
      if (!pd) return;
      (pd.entries || []).forEach((e, i) => {
        const r = M.PANEL_FIRST_ROW + i;
        if (Number(e.deposit))    set(r, p.col + M.PANEL_COL.deposit, Number(e.deposit));
        if (Number(e.freeChips))  set(r, p.col + M.PANEL_COL.freeChips, Number(e.freeChips));
        if (Number(e.withdrawal)) set(r, p.col + M.PANEL_COL.withdrawal, Number(e.withdrawal));
      });
      const sRow = M.DW_SUMMARY.firstRow + pi;
      set(sRow, M.DW_SUMMARY.cols.panel, p.slug);
      set(sRow, M.DW_SUMMARY.cols.totalDeposit, Number(pd.totalDeposit) || 0);
      set(sRow, M.DW_SUMMARY.cols.totalWithdrawal, Number(pd.totalWithdrawal) || 0);
      set(sRow, M.DW_SUMMARY.cols.diff, (Number(pd.totalDeposit) || 0) - (Number(pd.totalWithdrawal) || 0));
    });
  }

  // Ledgers
  (data.bankExp || []).forEach((row, i) => {
    const r = M.BANK_EXP.firstRow + i;
    set(r, M.BANK_EXP.cols.sr, i + 1);
    if (Number(row.credit))  { set(r, M.BANK_EXP.cols.credit, Number(row.credit));  set(r, M.BANK_EXP.cols.creditDetails, row.creditDetails || ''); }
    if (Number(row.debit))   { set(r, M.BANK_EXP.cols.debit,  Number(row.debit));   set(r, M.BANK_EXP.cols.debitDetails,  row.debitDetails  || ''); }
  });
  (data.parking || []).forEach((row, i) => {
    const r = M.PARKING.firstRow + i;
    if (Number(row.credit))  { set(r, M.PARKING.cols.credit, Number(row.credit));  set(r, M.PARKING.cols.creditDetails, row.creditDetails || ''); }
    if (Number(row.debit))   { set(r, M.PARKING.cols.debit,  Number(row.debit));   set(r, M.PARKING.cols.debitDetails,  row.debitDetails  || ''); }
  });

  return { grid, cols: COLS, rows: ROWS };
}

module.exports = { writeWorkbook, buildDataForDate, buildGrid };
