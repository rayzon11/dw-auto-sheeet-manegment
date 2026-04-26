'use strict';
const express = require('express');
const multer = require('multer');
const { db, audit } = require('../lib/db');
const A = require('../lib/auth');
const { businessDate, currentBusinessDate } = require('../lib/businessDate');
const { parseDcbPdf } = require('../parsers/dcb_pdf');
const { parseGenericBankPdf } = require('../parsers/generic_pdf');
const { parseGpayAuto } = require('../parsers/gpay');
const { parseSms } = require('../parsers/sms');
const { detectFromText } = require('../parsers/bankDetect');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ── PREVIEW: parse file, return rows, do NOT save ─────────────
router.post('/preview/bank-statement', A.requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'no file' });
  try {
    // Try generic parser first (handles any bank). Fall back to DCB-specific
    // if generic finds nothing or obviously less than DCB would.
    let parsed;
    try { parsed = await parseGenericBankPdf(req.file.buffer); } catch (_) { parsed = { rows: [], text: '', pages: 0 }; }
    if (parsed.rows.length < 3) {
      const dcb = await parseDcbPdf(req.file.buffer);
      if (dcb.rows.length > parsed.rows.length) parsed = { ...dcb, text: dcb.text || parsed.text };
    }
    const existing = new Set(db.prepare('SELECT ext_ref FROM bank_txns WHERE ext_ref IS NOT NULL').all().map(r => r.ext_ref)
      .concat(db.prepare('SELECT ext_ref FROM dw WHERE ext_ref IS NOT NULL').all().map(r => r.ext_ref)));
    const rows = parsed.rows.map(r => ({ ...r, duplicate: existing.has(r.ext_ref) }));
    const detected = detectFromText(parsed.text || '', { autoRegister: true });
    res.json({ ok: true, pages: parsed.pages, rows, detected });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

router.post('/commit/bank-statement', A.requireAuth, async (req, res) => {
  const { rows, bank_id } = req.body || {};
  if (!Array.isArray(rows)) return res.status(400).json({ ok: false, error: 'rows required' });
  if (!bank_id) return res.status(400).json({ ok: false, error: 'bank_id required (which bank is this statement for?)' });
  let insertedBank = 0, insertedDw = 0, skipped = 0;
  const insBank = db.prepare(`INSERT OR IGNORE INTO bank_txns(business_date, ts, bank_id, type, amt, detail, category, source, ext_ref, created_by)
                              VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const insDw = db.prepare(`INSERT OR IGNORE INTO dw(business_date, ts, type, amt, name, utr, remark, source, ext_ref, created_by)
                            VALUES (?,?,?,?,?,?,?,?,?,?)`);
  // Per business rule, bank-statement rows NEVER create DW deposit /
  // withdrawal entries — only bank_txns. The Chrome extension (panel
  // scrape) is the single source of truth for D/W. Reconciliation
  // happens on the sheet, not at ingest time.
  const tx = db.transaction((items) => {
    for (const r of items) {
      if (r.skip) { skipped++; continue; }
      const bd = r.business_date || businessDate(r.date + 'T12:00:00+05:30') || currentBusinessDate();
      const type = (r.entryKind === 'bank_charge') ? 'debit' : r.type;
      const category = r.entryKind === 'bank_charge' ? 'charge' : 'bank';
      const info = insBank.run(bd, r.date || null, Number(bank_id), type, Number(r.amt) || 0, r.narration || '',
                               category, 'statement', r.ext_ref || null, req.user.id);
      if (info.changes) insertedBank++; else skipped++;
    }
  });
  tx(rows);
  audit(req.user.id, 'ingest', 'bank_statement', null, { bank_id, insertedBank, insertedDw, skipped });
  res.json({ ok: true, insertedBank, insertedDw, skipped });
});

// ── GPAY ─────────────────────────────────────────────────────
router.post('/preview/gpay-statement', A.requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'no file' });
  try {
    const parsed = await parseGpayAuto(req.file.originalname, req.file.buffer);
    const existing = new Set(db.prepare('SELECT ext_ref FROM gpay WHERE ext_ref IS NOT NULL').all().map(r => r.ext_ref));
    const rows = parsed.rows.map(r => ({ ...r, duplicate: existing.has(r.ext_ref) }));
    res.json({ ok: true, pages: parsed.pages || null, rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

router.post('/commit/gpay-statement', A.requireAuth, (req, res) => {
  const { rows } = req.body || {};
  if (!Array.isArray(rows)) return res.status(400).json({ ok: false, error: 'rows required' });
  let inserted = 0, skipped = 0;
  const ins = db.prepare(`INSERT OR IGNORE INTO gpay(business_date, ts, type, amt, name, utr, remark, source, ext_ref, created_by)
                          VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const tx = db.transaction((items) => {
    for (const r of items) {
      if (r.skip) { skipped++; continue; }
      const bd = r.business_date || currentBusinessDate();
      const info = ins.run(bd, r.ts || null, r.type, Number(r.amt) || 0, r.name || '', r.utr || '',
                           r.remark || '', 'statement', r.ext_ref || null, req.user.id);
      if (info.changes) inserted++; else skipped++;
    }
  });
  tx(rows);
  audit(req.user.id, 'ingest', 'gpay_statement', null, { inserted, skipped });
  res.json({ ok: true, inserted, skipped });
});

// ── PANEL (Chrome extension) ─────────────────────────────────
router.post('/panel', A.requireAuthOrToken, (req, res) => {
  const { site, deposits, withdrawals } = req.body || {};
  if (!site) return res.status(400).json({ ok: false, error: 'site required' });
  const ins = db.prepare(`INSERT OR IGNORE INTO dw(business_date, ts, panel_slug, type, amt, name, utr, remark, source, ext_ref, created_by)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  let inserted = 0, skipped = 0;
  const tx = db.transaction((items, type) => {
    for (const e of items) {
      const ts = e.ts || e.date || null;
      const bd = ts ? businessDate(ts + 'T12:00:00+05:30') : currentBusinessDate();
      const utr = e.utr || '';
      const extRef = utr ? `${site}:${utr}` : `${site}:${ts || ''}|${e.amount}|${(e.name || '').trim()}`;
      const info = ins.run(bd, ts, site, type, Number(e.amount) || 0, e.name || '', utr,
                           e.bank || '', 'extension', extRef, req.user.id);
      if (info.changes) inserted++; else skipped++;
    }
  });
  tx(deposits || [], 'Deposit');
  tx(withdrawals || [], 'Withdrawal');

  db.prepare(`INSERT INTO settings(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(`panel_last_sync:${site}`, new Date().toISOString());

  audit(req.user.id, 'ingest', 'panel:' + site, null, { inserted, skipped });
  res.json({ ok: true, inserted, skipped });
});

router.get('/panel/status', A.requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT key, value FROM settings WHERE key LIKE 'panel_last_sync:%'`).all();
  const out = {};
  for (const r of rows) out[r.key.replace('panel_last_sync:', '')] = r.value;
  res.json({ ok: true, last_sync: out });
});

// ── SMS / NOTIFICATION INGEST (Android app) ───────────────────
// Accepts: { messages: [{ sender, body, ts, source?: 'sms'|'notif' }, ...] }
// Auth: bearer token (same as panel extension).
router.post('/sms', A.requireAuthOrToken, (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages)) return res.status(400).json({ ok: false, error: 'messages required' });

  // bank name → bank_id map (case-insensitive match on "name" column)
  let allBanks = db.prepare('SELECT id, name FROM banks').all();
  const bankIdFor = (code) => {
    if (!code) return null;
    const lc = code.toLowerCase();
    const hit = allBanks.find(b => (b.name || '').toLowerCase().includes(lc) ||
                                    lc.includes((b.name || '').toLowerCase()));
    if (hit) return hit.id;
    // Auto-create a new bank row when SMS references an unknown bank
    const info = db.prepare('INSERT INTO banks(name, holder, acno, open_balance) VALUES (?,?,?,?)')
                   .run(code, '', '', 0);
    allBanks = db.prepare('SELECT id, name FROM banks').all();
    return info.lastInsertRowid;
  };

  const insBank = db.prepare(`INSERT OR IGNORE INTO bank_txns(business_date, ts, bank_id, type, amt, detail, category, source, ext_ref, balance, mode, created_by)
                              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insDw = db.prepare(`INSERT OR IGNORE INTO dw(business_date, ts, type, amt, name, utr, remark, source, ext_ref, created_by)
                            VALUES (?,?,?,?,?,?,?,?,?,?)`);

  let parsed = 0, unknownBank = 0, insertedBank = 0, insertedDw = 0, skipped = 0, ignored = 0;
  const unmapped = [];

  const tx = db.transaction((items) => {
    for (const m of items) {
      const p = parseSms(m);
      if (!p) { ignored++; continue; }
      parsed++;
      const bd = p.ts ? businessDate(new Date(p.ts).toISOString()) : currentBusinessDate();
      const bank_id = bankIdFor(p.bank);
      if (!bank_id && p.bank) { unknownBank++; unmapped.push(p.bank); }

      // NO MIRROR TO DW. Per business rule, the gaming panel (Freeplay /
      // Testawl247 via the Chrome extension) is the SOLE source of truth
      // for Deposit / Withdrawal rows. Bank credits/debits stay strictly
      // in bank_txns — the reconciliation step (panel deposit vs bank
      // credit) decides where the "leftover" credited amount lands
      // (B2C BANK & EXP DETAILS / parking / etc).
      const info = insBank.run(bd, p.ts || null, bank_id || null, p.type, p.amt,
                               (p.counterparty || p.raw.body.slice(0, 180)),
                               p.category || 'bank', 'sms', p.ext_ref,
                               p.balance, p.mode, req.user.id);
      if (info.changes) insertedBank++; else skipped++;
    }
  });
  tx(messages);

  audit(req.user.id, 'ingest', 'sms', null, { parsed, insertedBank, insertedDw, skipped, ignored, unknownBank });
  res.json({ ok: true, parsed, insertedBank, insertedDw, skipped, ignored, unknownBank,
             hint: unknownBank ? `Add banks to the Banks tab named like: ${[...new Set(unmapped)].join(', ')}` : null });
});

// Dry-run parser for debugging: POST {body, sender} → returns what would be inserted
router.post('/sms/parse', A.requireAuthOrToken, (req, res) => {
  const p = parseSms(req.body || {});
  res.json({ ok: true, parsed: p });
});

module.exports = router;
