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

// Build a fresh zip from a source folder if older than the folder mtime.
async function ensureZip(srcDir, outZip) {
  const fs = require('fs');
  const archiver = require('archiver');
  const SKIP = new Set(['node_modules','build','.gradle','.idea','.cxx','.externalNativeBuild','captures']);
  function newest(dir) {
    let max = 0; let stack = [dir]; let n = 0;
    while (stack.length && n < 5000) {
      const d = stack.pop();
      let entries; try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
      for (const e of entries) {
        n++;
        if (SKIP.has(e.name)) continue;
        const p = path.join(d, e.name);
        try {
          const st = fs.statSync(p);
          if (st.mtimeMs > max) max = st.mtimeMs;
          if (e.isDirectory()) stack.push(p);
        } catch (_) {}
      }
    }
    return max;
  }
  if (!fs.existsSync(srcDir)) throw new Error('source missing: ' + srcDir);
  const srcMtime = newest(srcDir);
  let outMtime = 0; try { outMtime = fs.statSync(outZip).mtimeMs; } catch (_) {}
  if (fs.existsSync(outZip) && srcMtime <= outMtime) return outZip;
  fs.mkdirSync(path.dirname(outZip), { recursive: true });
  try { fs.unlinkSync(outZip); } catch (_) {}
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(outZip);
    const archive = archiver('zip', { zlib: { level: 9 } });
    out.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(out);
    archive.glob('**/*', {
      cwd: srcDir,
      ignore: ['**/node_modules/**','**/build/**','**/.gradle/**','**/.idea/**',
               '**/.cxx/**','**/.externalNativeBuild/**','**/captures/**'],
      dot: false,
    });
    archive.finalize();
  });
  return outZip;
}

// Download the Chrome extension as a zip
app.get('/extension.zip', async (req, res) => {
  try {
    const out = await ensureZip(
      path.join(__dirname, '..', 'extension'),
      path.join(__dirname, '..', 'data', 'extension.zip'));
    res.download(out, 'b2c-hisab-extension.zip');
  } catch (e) { res.status(500).send('zip failed: ' + e.message); }
});

// Download the Android app source as a zip (excludes build, .gradle, .idea)
app.get('/android-source.zip', async (req, res) => {
  try {
    const out = await ensureZip(
      path.join(__dirname, '..', 'android'),
      path.join(__dirname, '..', 'data', 'android-source.zip'));
    res.download(out, 'b2c-hisab-android-source.zip');
  } catch (e) { res.status(500).send('zip failed: ' + e.message); }
});

// Download the prebuilt debug APK if present
app.get('/android-debug.apk', (req, res) => {
  const fs = require('fs');
  const candidates = [
    path.join(__dirname, '..', 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'),
    path.join(__dirname, '..', 'data', 'app-debug.apk'),
  ];
  for (const p of candidates) if (fs.existsSync(p)) return res.download(p, 'b2c-hisab.apk');
  res.status(404).send('No APK built yet. Run `./gradlew assembleDebug` in the android/ folder.');
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
