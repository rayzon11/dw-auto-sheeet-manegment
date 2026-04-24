'use strict';
// Balance-gap reconciliation.
// Each SMS carries an "Avl Bal" — stored in bank_txns.balance. For each bank,
// we sort SMS by ts and compare: bal[i] should equal bal[i-1] + credit[i] - debit[i].
// Any mismatch means a txn was missed (SMS never arrived / parser couldn't read).
// We expose /api/reconcile which returns per-bank gap rows the UI shows as alerts.

const express = require('express');
const { db } = require('../lib/db');
const A = require('../lib/auth');
const { currentBusinessDate } = require('../lib/businessDate');

const router = express.Router();
router.use(A.requireAuth);

router.get('/', (req, res) => {
  const from = req.query.from || currentBusinessDate();
  const to   = req.query.to   || from;
  const rows = db.prepare(`
    SELECT id, bank_id, business_date, ts, type, amt, balance, detail
    FROM bank_txns
    WHERE business_date BETWEEN ? AND ?
      AND balance IS NOT NULL AND bank_id IS NOT NULL
    ORDER BY bank_id, ts
  `).all(from, to);

  const banks = db.prepare('SELECT id, name FROM banks').all();
  const bankName = Object.fromEntries(banks.map(b => [b.id, b.name]));

  const gaps = [];
  const byBank = {};
  for (const r of rows) {
    byBank[r.bank_id] = byBank[r.bank_id] || [];
    byBank[r.bank_id].push(r);
  }
  for (const [bid, list] of Object.entries(byBank)) {
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1], cur = list[i];
      const signedDelta = cur.type === 'credit' ? cur.amt : -cur.amt;
      const expected = prev.balance + signedDelta;
      const diff = Math.round((cur.balance - expected) * 100) / 100;
      if (Math.abs(diff) >= 1) {
        gaps.push({
          bank_id: Number(bid),
          bank: bankName[bid] || `bank#${bid}`,
          between_ts: [prev.ts, cur.ts],
          prev_balance: prev.balance,
          observed_balance: cur.balance,
          expected_balance: Math.round(expected * 100) / 100,
          missing_amount: diff,    // positive = missing credit, negative = missing debit
          likely: diff > 0 ? 'missed credit SMS' : 'missed debit SMS',
        });
      }
    }
  }

  res.json({ ok: true, from, to, scanned: rows.length, gaps });
});

// Quick summary for dashboard badge
router.get('/count', (req, res) => {
  const from = req.query.from || currentBusinessDate();
  const to   = req.query.to   || from;
  // Reuse the main route's logic via an internal fetch would be nice, but cheaper to inline:
  const rows = db.prepare(`
    SELECT bank_id, type, amt, balance, ts FROM bank_txns
    WHERE business_date BETWEEN ? AND ? AND balance IS NOT NULL AND bank_id IS NOT NULL
    ORDER BY bank_id, ts
  `).all(from, to);
  let gaps = 0;
  const byBank = {};
  for (const r of rows) (byBank[r.bank_id] = byBank[r.bank_id] || []).push(r);
  for (const list of Object.values(byBank)) {
    for (let i = 1; i < list.length; i++) {
      const exp = list[i-1].balance + (list[i].type === 'credit' ? list[i].amt : -list[i].amt);
      if (Math.abs(list[i].balance - exp) >= 1) gaps++;
    }
  }
  res.json({ ok: true, gaps });
});

module.exports = router;
