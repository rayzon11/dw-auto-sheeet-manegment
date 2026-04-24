'use strict';
const { parse: csvParse } = require('csv-parse/sync');
const pdfParse = require('pdf-parse');
const { businessDate } = require('../lib/businessDate');

function parseAmt(s) {
  if (s == null) return 0;
  const n = parseFloat(String(s).replace(/,/g, '').replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

function normalizeType(s) {
  const t = String(s || '').toLowerCase();
  if (/receiv|credit|in\b/.test(t)) return 'Received';
  if (/sent|debit|paid|out\b/.test(t)) return 'Sent';
  return s || 'Unknown';
}

function parseDateTime(s) {
  if (!s) return null;
  const str = String(s).trim();
  const iso = Date.parse(str);
  if (!isNaN(iso)) return new Date(iso).toISOString();
  const m = str.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) {
    let [, d, mo, y, h, mi, se] = m;
    if (y.length === 2) y = '20' + y;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${(h || '12').padStart(2, '0')}:${(mi || '00').padStart(2, '0')}:${(se || '00').padStart(2, '0')}+05:30`;
  }
  return null;
}

function headerIndex(headers, patterns) {
  for (let i = 0; i < headers.length; i++) {
    const h = String(headers[i] || '').toLowerCase();
    if (patterns.some(p => p.test(h))) return i;
  }
  return -1;
}

function parseGpayCsv(buffer) {
  const text = buffer.toString('utf8');
  const records = csvParse(text, { columns: false, skip_empty_lines: true, relax_column_count: true });
  if (!records.length) return { rows: [] };
  const headers = records[0];
  const ci = {
    date: headerIndex(headers, [/date|time/]),
    type: headerIndex(headers, [/type|direction/]),
    amt: headerIndex(headers, [/amount|amt/]),
    name: headerIndex(headers, [/name|to\/from|counter|payee|payer|customer/]),
    utr: headerIndex(headers, [/utr|txn|transaction|upi\s*ref|ref/]),
    status: headerIndex(headers, [/status/]),
  };
  const rows = [];
  for (let r = 1; r < records.length; r++) {
    const row = records[r];
    const dateStr = ci.date >= 0 ? row[ci.date] : '';
    const ts = parseDateTime(dateStr);
    const amt = parseAmt(ci.amt >= 0 ? row[ci.amt] : '');
    if (!amt) continue;
    const type = normalizeType(ci.type >= 0 ? row[ci.type] : '');
    const name = ci.name >= 0 ? row[ci.name] : '';
    const utr = ci.utr >= 0 ? row[ci.utr] : '';
    const status = ci.status >= 0 ? row[ci.status] : '';
    if (status && /fail|cancel|reject/i.test(status)) continue;
    const ext_ref = utr ? 'gpay:' + utr : `gpay:${ts || dateStr}|${amt}|${name}`;
    rows.push({
      business_date: businessDate(ts || Date.now()),
      ts, type, amt, name: String(name || '').trim(), utr: String(utr || '').trim(), ext_ref,
    });
  }
  return { rows };
}

async function parseGpayPdf(buffer) {
  const data = await pdfParse(buffer);
  const text = data.text || '';
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const rows = [];
  const amtRe = /₹?\s*([\d,]+\.\d{2})/;
  const dateRe = /(\d{1,2}\s+\w{3,}\s+\d{4}(?:,?\s+\d{1,2}:\d{2}(?:\s*[AP]M)?)?)/i;
  const typeRe = /\b(Paid to|Received from|Sent to|Money received|Money sent)\b/i;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const tm = l.match(typeRe);
    if (!tm) continue;
    const block = (lines.slice(Math.max(0, i - 2), i + 4)).join(' | ');
    const am = block.match(amtRe);
    const dm = block.match(dateRe);
    if (!am) continue;
    const amt = parseAmt(am[1]);
    const ts = parseDateTime(dm ? dm[1] : '');
    const direction = /Paid|Sent/i.test(tm[1]) ? 'Sent' : 'Received';
    const name = l.replace(typeRe, '').trim();
    const utrM = block.match(/\b(UPI\s*Ref(?:erence)?\s*(?:No|ID)?[:\s]*([A-Z0-9]{8,})|\b\d{12}\b)/i);
    const utr = utrM ? (utrM[2] || utrM[0]) : '';
    const ext_ref = utr ? 'gpay:' + utr : `gpay:${ts || ''}|${amt}|${name}`;
    rows.push({
      business_date: businessDate(ts || Date.now()),
      ts, type: direction, amt, name, utr, ext_ref,
    });
  }
  return { pages: data.numpages, rows };
}

async function parseGpayAuto(filename, buffer) {
  const ext = String(filename || '').toLowerCase();
  if (ext.endsWith('.csv') || ext.endsWith('.tsv')) return parseGpayCsv(buffer);
  if (ext.endsWith('.pdf')) return await parseGpayPdf(buffer);
  try { return parseGpayCsv(buffer); } catch (e) { return await parseGpayPdf(buffer); }
}

module.exports = { parseGpayAuto, parseGpayCsv, parseGpayPdf };
