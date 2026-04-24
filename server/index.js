'use strict';
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const { db } = require('./lib/db');
const A = require('./lib/auth');
const authRoutes = require('./routes/auth');
const entryRoutes = require('./routes/entries');
const ingestRoutes = require('./routes/ingest');
const sheetRoutes = require('./routes/sheet');
const reconcileRoutes = require('./routes/reconcile');
const { currentBusinessDate } = require('./lib/businessDate');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

function bootstrap() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count === 0) {
    const admin = process.env.ADMIN_USER || 'admin';
    const pass = process.env.ADMIN_PASS || 'admin123';
    db.prepare('INSERT INTO users(username, password_hash, role) VALUES (?,?,?)')
      .run(admin, A.hashPassword(pass), 'admin');
    console.log(`[bootstrap] created initial admin user: ${admin} / ${pass}  (change immediately)`);
  }
  // Auto-register the bundled master sheet as the default template (for testing)
  const fs = require('fs');
  const tplDefault = path.join(__dirname, '..', 'sheet.xlsx');
  const tplDest = path.join(__dirname, '..', 'data', 'templates', 'master.xlsx');
  if (fs.existsSync(tplDefault)) {
    fs.mkdirSync(path.dirname(tplDest), { recursive: true });
    if (!fs.existsSync(tplDest)) fs.copyFileSync(tplDefault, tplDest);
    db.prepare(
      `INSERT INTO settings(key, value) VALUES ('sheet_template_path', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(tplDest);
    console.log('[bootstrap] sheet template registered:', tplDest);
  }
}
bootstrap();

// Download the Chrome extension as a zip
app.get('/extension.zip', (req, res) => {
  const { execFileSync } = require('child_process');
  const fs = require('fs');
  const extDir = path.join(__dirname, '..', 'extension');
  const outZip = path.join(__dirname, '..', 'data', 'extension.zip');
  try {
    if (!fs.existsSync(outZip) ||
        fs.statSync(extDir).mtimeMs > fs.statSync(outZip).mtimeMs) {
      fs.mkdirSync(path.dirname(outZip), { recursive: true });
      try { fs.unlinkSync(outZip); } catch (_) {}
      // Use PowerShell Compress-Archive — works on Windows without extra deps
      execFileSync('powershell', ['-Command',
        `Compress-Archive -Path '${extDir}\\*' -DestinationPath '${outZip}' -Force`],
        { stdio: 'ignore' });
    }
    res.download(outZip, 'b2c-hisab-extension.zip');
  } catch (e) {
    res.status(500).send('zip failed: ' + e.message);
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, business_date: currentBusinessDate(), time: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api/ingest', ingestRoutes);
app.use('/api/sheet', sheetRoutes);
app.use('/api/reconcile', reconcileRoutes);
app.use('/api', entryRoutes);

app.use(express.static(PUBLIC_DIR));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n  B2C Hisab server running:  http://localhost:${PORT}\n  DB:  ${require('./lib/db').DB_PATH}\n`);
  try { require('./lib/rollover').start(); } catch (e) { console.error('rollover scheduler:', e); }
});
