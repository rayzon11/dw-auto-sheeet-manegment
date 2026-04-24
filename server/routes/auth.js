'use strict';
const express = require('express');
const { db, audit } = require('../lib/db');
const A = require('../lib/auth');

const router = express.Router();

router.post('/login', (req, res) => {
  const { username, password, remember } = req.body || {};
  if (!username || !password) return res.status(400).json({ ok: false, error: 'username and password required' });

  const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(String(username).trim());
  if (!user || !A.verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ ok: false, error: 'invalid credentials' });
  }
  const sid = A.createSession(user.id);
  const remRaw = remember ? A.createRememberToken(user.id, req.headers['user-agent'] || 'unknown') : null;
  A.setAuthCookies(res, sid, remRaw);
  audit(user.id, 'login', 'user', user.id, { ua: req.headers['user-agent'] });
  res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role } });
});

router.post('/logout', (req, res) => {
  const sid = req.cookies[A.SESSION_COOKIE];
  A.destroySession(sid);
  A.clearAuthCookies(res);
  res.json({ ok: true });
});

router.get('/me', A.requireAuth, (req, res) => {
  res.json({ ok: true, user: {
    id: req.user.id, username: req.user.username, role: req.user.role,
    caps: A.caps(req.user.role),
  } });
});

router.post('/change-password', A.requireAuth, (req, res) => {
  const { current, next: newPw } = req.body || {};
  if (!current || !newPw) return res.status(400).json({ ok: false, error: 'current and next required' });
  if (String(newPw).length < 6) return res.status(400).json({ ok: false, error: 'password too short (min 6)' });
  if (!A.verifyPassword(current, req.user.password_hash)) {
    return res.status(401).json({ ok: false, error: 'current password incorrect' });
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(A.hashPassword(newPw), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.user.id);
  db.prepare('DELETE FROM devices WHERE user_id = ?').run(req.user.id);
  A.clearAuthCookies(res);
  audit(req.user.id, 'change-password', 'user', req.user.id);
  res.json({ ok: true });
});

router.get('/users', A.requireAuth, A.requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT id, username, role, is_active, created_at FROM users ORDER BY id').all();
  res.json({ ok: true, users: rows });
});

router.post('/users', A.requireAuth, A.requireAdmin, (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ ok: false, error: 'username and password required' });
  const r = (role === 'admin') ? 'admin' : 'operator';
  try {
    const info = db.prepare('INSERT INTO users(username, password_hash, role) VALUES (?,?,?)')
      .run(String(username).trim(), A.hashPassword(password), r);
    audit(req.user.id, 'create-user', 'user', info.lastInsertRowid, { username, role: r });
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

router.patch('/users/:id', A.requireAuth, A.requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const { is_active, role, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ ok: false, error: 'user not found' });

  if (typeof is_active !== 'undefined') {
    db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(is_active ? 1 : 0, id);
    if (!is_active) {
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      db.prepare('DELETE FROM devices WHERE user_id = ?').run(id);
    }
  }
  if (role && (role === 'admin' || role === 'operator')) {
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  }
  if (password) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(A.hashPassword(password), id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM devices WHERE user_id = ?').run(id);
  }
  audit(req.user.id, 'update-user', 'user', id, { is_active, role, password: password ? '***' : undefined });
  res.json({ ok: true });
});

router.post('/tokens', A.requireAuth, (req, res) => {
  const { label } = req.body || {};
  const raw = A.createApiToken(req.user.id, label || 'extension');
  audit(req.user.id, 'create-token', 'api_token', null, { label });
  res.json({ ok: true, token: raw });
});

router.get('/tokens', A.requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id, label, created_at FROM api_tokens WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
  res.json({ ok: true, tokens: rows });
});

router.delete('/tokens/:id', A.requireAuth, (req, res) => {
  db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});

module.exports = router;
