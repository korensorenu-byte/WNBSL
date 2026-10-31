import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query, withTransaction } from '../db/index.js';
import { signToken, authenticate, httpError } from '../middleware/auth.js';
import { wrap, audit } from '../lib/http.js';
import crypto from 'node:crypto';
import { notify, appUrl } from '../lib/notify.js';
import { passwordResetEmail, passwordChangedEmail } from '../lib/templates.js';

const RESET_MINUTES = 60;
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

const router = Router();

// Simple in-memory throttle: 10 failed attempts per email per 15 minutes.
const failures = new Map();
const WINDOW_MS = 15 * 60 * 1000;

router.post('/login', wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const record = failures.get(email);
  if (record && record.count >= 10 && Date.now() - record.first < WINDOW_MS) {
    throw httpError(429, 'Too many failed attempts. Try again in 15 minutes.');
  }

  const { rows } = await query('SELECT * FROM users WHERE email = $1 AND active = TRUE', [email]);
  const user = rows[0];
  const ok = user && (await bcrypt.compare(password, user.password_hash));
  if (!ok) {
    const r = failures.get(email) && Date.now() - failures.get(email).first < WINDOW_MS
      ? failures.get(email)
      : { count: 0, first: Date.now() };
    r.count += 1;
    failures.set(email, r);
    throw httpError(401, 'Email or password is incorrect');
  }

  failures.delete(email);
  res.json({
    token: signToken(user),
    user: { id: user.id, email: user.email, fullName: user.full_name, role: user.role, memberId: user.member_id },
  });
}));

router.get('/me', authenticate, wrap(async (req, res) => {
  const { rows } = await query('SELECT id, email, full_name, role, member_id FROM users WHERE id = $1', [req.user.sub]);
  if (!rows[0]) throw httpError(401, 'Account no longer exists');
  const u = rows[0];
  res.json({ id: u.id, email: u.email, fullName: u.full_name, role: u.role, memberId: u.member_id });
}));

// Step 1: email a reset link. The answer is the same whether or not the account exists.
router.post('/forgot', wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const generic = { ok: true, message: 'If an account exists for this email, a reset link has been sent.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.json(generic);

  const u = await query('SELECT id, email, full_name FROM users WHERE email = $1 AND active = TRUE', [email]);
  const user = u.rows[0];
  if (user) {
    const token = crypto.randomBytes(32).toString('base64url');
    await query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [user.id]);
    await query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + ($3 || ' minutes')::interval)`,
      [user.id, hashToken(token), String(RESET_MINUTES)]);
    const link = `${appUrl()}/reset/${token}`;
    await notify({ to: user.email, ...passwordResetEmail({ name: user.full_name, link }) });
  }
  res.json(generic);
}));

// Check a reset link before showing the form.
router.get('/reset/:token', wrap(async (req, res) => {
  const r = await query(
    `SELECT pr.used_at, pr.expires_at, u.email FROM password_resets pr JOIN users u ON u.id = pr.user_id
      WHERE pr.token_hash = $1`, [hashToken(req.params.token)]);
  const row = r.rows[0];
  if (!row || row.used_at || new Date(row.expires_at) < new Date()) {
    throw httpError(410, 'This reset link is not valid or has expired. Please request a new one.');
  }
  res.json({ email: row.email, expiresAt: row.expires_at });
}));

// Step 2: set the new password. Also signs the user in.
router.post('/reset', wrap(async (req, res) => {
  const { token, password } = req.body || {};
  if (!password || String(password).length < 12) throw httpError(400, 'Password must be at least 12 characters');
  const bcrypt = (await import('bcryptjs')).default;
  const hash = await bcrypt.hash(String(password), 12);

  const user = await withTransaction(async (c) => {
    const r = await c.query(
      `SELECT pr.id, pr.user_id, pr.used_at, pr.expires_at FROM password_resets pr WHERE pr.token_hash = $1 FOR UPDATE`,
      [hashToken(String(token || ''))]);
    const pr = r.rows[0];
    if (!pr || pr.used_at || new Date(pr.expires_at) < new Date()) {
      throw httpError(410, 'This reset link is not valid or has expired. Please request a new one.');
    }
    await c.query('UPDATE password_resets SET used_at = now() WHERE id = $1', [pr.id]);
    const u = await c.query(
      `UPDATE users SET password_hash = $2 WHERE id = $1 AND active = TRUE
       RETURNING id, email, full_name, role, member_id`, [pr.user_id, hash]);
    if (!u.rows[0]) throw httpError(400, 'This account is not active');
    await audit({ sub: u.rows[0].id }, 'auth.password_reset', 'user', u.rows[0].id, null, c);
    return u.rows[0];
  });

  await notify({ to: user.email, ...passwordChangedEmail({ name: user.full_name }) });
  res.json({
    token: signToken(user),
    user: { id: user.id, email: user.email, fullName: user.full_name, role: user.role, memberId: user.member_id },
  });
}));

export default router;
