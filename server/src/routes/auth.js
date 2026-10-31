import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query } from '../db/index.js';
import { signToken, authenticate, httpError } from '../middleware/auth.js';
import { wrap } from '../lib/http.js';

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

export default router;
