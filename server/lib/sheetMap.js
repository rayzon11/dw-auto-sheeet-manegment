'use strict';
// Cell-coordinate map for "DW SHEET DEMO NEW 11-03-26.xlsx" (tab: DEMO).
// All rows/cols are 0-indexed. Convert to A1 via XLSX.utils.encode_cell({r,c}).
// This is the single source of truth for both the .xlsx writer and the
// Google Sheets writer — both consume the same coordinate objects.

const PANELS = [
  { slug: '1XBET0001', col: 14 }, // O = deposit, P = free chips, Q = withdrawal, R = blank
  { slug: '1XBET0002', col: 18 },
  { slug: '1XBET0003', col: 22 },
  { slug: '1XBET0004', col: 26 },
  { slug: '1XBET0005', col: 30 },
  { slug: '1XBET0006', col: 34 },
];
// Per-panel column offsets from the panel's base col:
const PANEL_COL = { deposit: 0, freeChips: 1, withdrawal: 2 };
const PANEL_FIRST_ROW = 2;    // first data row (0-indexed). Extend downward as needed.
const PANEL_LAST_ROW  = 500;  // soft cap — rewriter will overwrite this range.

// Banks block: cols A..H, rows 3..52. One row per bank (Sr starts at 1).
const BANK = {
  firstRow: 3, lastRow: 52,
  cols: { sr: 0, name: 1, holder: 2, open: 3, credit: 4, debit: 6, closing: 7 },
};

// DW summary (panel totals) — rows 6..11 (one per panel), cols J..M.
const DW_SUMMARY = {
  firstRow: 6,
  cols: { panel: 9, totalDeposit: 10, totalWithdrawal: 11, diff: 12 },
  totalRow: 12,
};
// Chips summary — rows 17..22.
const CHIPS_SUMMARY = {
  firstRow: 17,
  cols: { panel: 9, openChips: 10, closeChips: 11, diff: 12 },
  totalRow: 23,
};

// B2C Bank & Expense ledger — rows 61..110 (growable), cols B..E.
// Categories written into the "Details" col: BANK CHG, FREE CHIPS, SALARY,
// EXTRA PAYMENT, ATM — a credit or debit row depending on sign.
const BANK_EXP = {
  firstRow: 61, lastRow: 110,
  cols: { sr: 0, credit: 1, creditDetails: 2, debit: 3, debitDetails: 4 },
};
// Parking Payment Transfer ledger — same row range, cols G..K.
const PARKING = {
  firstRow: 61, lastRow: 110,
  cols: { sr: 0 /* no Sr col in parking block — reuse BANK_EXP Sr */,
          credit: 6, creditDetails: 7, debit: 9, debitDetails: 10 },
};

// Categories that flow into the bank-exp ledger (left-side bottom block).
// Each maps to the side (credit / debit) the entry is written on.
const CATEGORIES = {
  bank_charge:    { block: 'BANK_EXP', side: 'debit', label: 'BANK CHG' },
  free_chips:     { block: 'BANK_EXP', side: 'debit', label: 'FREE CHIPS' },
  salary:         { block: 'BANK_EXP', side: 'debit', label: 'SALARY' },
  extra_payment:  { block: 'BANK_EXP', side: 'debit', label: 'EXTRA PAYMENT' },
  atm:            { block: 'BANK_EXP', side: 'debit', label: 'ATM' },
  parking_in:     { block: 'PARKING',  side: 'credit', label: 'PARKING IN' },
  parking_out:    { block: 'PARKING',  side: 'debit',  label: 'PARKING OUT' },
};

module.exports = {
  PANELS, PANEL_COL, PANEL_FIRST_ROW, PANEL_LAST_ROW,
  BANK, DW_SUMMARY, CHIPS_SUMMARY, BANK_EXP, PARKING, CATEGORIES,
};
