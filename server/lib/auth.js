'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, audit } = require('./db');

const SESSION_COOKIE = 'hisab_sid';
const REMEMBER_COOKIE = 'hisab_rem';
const SESSION_DAYS = 7;
const REMEMBER_DAYS = 30;

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}
function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}
function isoPlusDays(days) {
  return new Date(Date.now() + days * 86400000).toISOString();
}

function createSession(userId) {
  const sid = randomToken(24);
  db.prepare('INSERT INTO sessions(sid, user_id, expires_at) VALUES (?,?,?)')
    .run(sid, userId, isoPlusDays(SESSION_DAYS));
  return sid;
}

function destroySession(sid) {
  if (!sid) return;
  db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
}

function getSessionUser(sid) {
  if (!sid) return null;
  const row = db.prepare(`
    SELECT u.* FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.sid = ? AND s.expires_at > datetime('now') AND u.is_active = 1
  `).get(sid);
  return row || null;
}

function createRememberToken(userId, label) {
  const raw = randomToken(32);
  const hash = sha256(raw);
  db.prepare('INSERT INTO devices(user_id, token_hash, label, expires_at) VALUES (?,?,?,?)')
    .run(userId, hash, label || null, isoPlusDays(REMEMBER_DAYS));
  return raw;
}

function consumeRememberToken(raw) {
  if (!raw) return null;
  const hash = sha256(raw);
  const row = db.prepare(`
    SELECT d.id AS did, u.* FROM devices d
    JOIN users u ON u.id = d.user_id
    WHERE d.token_hash = ? AND d.expires_at > datetime('now') AND u.is_active = 1
  `).get(hash);
  if (!row) return null;
  db.prepare('UPDATE devices SET last_seen = datetime(\'now\') WHERE id = ?').run(row.did);
  return row;
}

function setAuthCookies(res, sid, rememberRaw) {
  const common = { httpOnly: true, sameSite: 'lax', path: '/' };
  res.cookie(SESSION_COOKIE, sid, { ...common, maxAge: SESSION_DAYS * 86400000 });
  if (rememberRaw) {
    res.cookie(REMEMBER_COOKIE, rememberRaw, { ...common, maxAge: REMEMBER_DAYS * 86400000 });
  }
}

function clearAuthCookies(res) {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.clearCookie(REMEMBER_COOKIE, { path: '/' });
}

function requireAuth(req, res, next) {
  let user = getSessionUser(req.cookies[SESSION_COOKIE]);
  if (!user) {
    const remembered = consumeRememberToken(req.cookies[REMEMBER_COOKIE]);
    if (remembered) {
      const sid = createSession(remembered.id);
      setAuthCookies(res, sid, null);
      user = remembered;
    }
  }
  if (!user) return res.status(401).json({ ok: false, error: 'auth required' });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ ok: false, error: 'admin only' });
  }
  next();
}

// admin + manager share full access
function requireManager(req, res, next) {
  if (!req.user || !['admin', 'manager'].includes(req.user.role)) {
    return res.status(403).json({ ok: false, error: 'manager+ only' });
  }
  next();
}

// Role capabilities (single source of truth for UI + routes)
const CAPS = {
  admin:             { all: true },
  manager:           { all: true },
  operator:          { deposit: true, withdrawal: true, freeplay: true, dw: true },
  deposit_operator:  { deposit: true, freeplay: true },
  withdrawal_operator:{ withdrawal: true, freeplay: true },
};
function caps(role) { return CAPS[role] || {}; }

function hashPassword(plain) {
  return bcrypt.hashSync(plain, 10);
}
function verifyPassword(plain, hash) {
  try { return bcrypt.compareSync(plain, hash); } catch (e) { return false; }
}

function verifyBearerToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const raw = authHeader.slice(7).trim();
  if (!raw) return null;
  const hash = sha256(raw);
  const row = db.prepare(`
    SELECT u.* FROM api_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ? AND u.is_active = 1
  `).get(hash);
  return row || null;
}

function requireAuthOrToken(req, res, next) {
  const tokUser = verifyBearerToken(req.headers.authorization);
  if (tokUser) { req.user = tokUser; return next(); }
  return requireAuth(req, res, next);
}

function createApiToken(userId, label) {
  const raw = randomToken(24);
  const hash = sha256(raw);
  db.prepare('INSERT INTO api_tokens(user_id, token_hash, label) VALUES (?,?,?)')
    .run(userId, hash, label || null);
  return raw;
}

module.exports = {
  SESSION_COOKIE, REMEMBER_COOKIE,
  createSession, destroySession, getSessionUser,
  createRememberToken, consumeRememberToken,
  setAuthCookies, clearAuthCookies,
  requireAuth, requireAdmin, requireManager, requireAuthOrToken, caps, CAPS,
  hashPassword, verifyPassword,
  createApiToken, sha256, randomToken, audit,
};
