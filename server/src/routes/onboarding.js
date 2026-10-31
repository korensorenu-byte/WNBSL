import { Router } from 'express';
import { query, withTransaction } from '../db/index.js';
import { authenticate, requireRole, httpError } from '../middleware/auth.js';
import { wrap, audit, isoDate } from '../lib/http.js';
import { getSettings } from '../lib/settings-store.js';
import { createInvitation, normaliseEmail } from '../lib/invitations.js';
import { notify, appUrl } from '../lib/notify.js';
import {
  membershipReceivedEmail, membershipDecisionEmail, adminNewRequestEmail, society,
} from '../lib/templates.js';

const router = Router();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Simple per-IP throttle for the public request form (in memory, per instance).
const hits = new Map();
function throttle(req, res, next) {
  const key = req.ip;
  const now = Date.now();
  const rec = hits.get(key) && now - hits.get(key).first < 60 * 60 * 1000 ? hits.get(key) : { count: 0, first: now };
  rec.count += 1;
  hits.set(key, rec);
  if (rec.count > 10) return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  next();
}

// ---- Public: landing page information (no login) ----
router.get('/public/info', wrap(async (req, res) => {
  const s = await getSettings();
  const products = await query(
    `SELECT name, description, annual_rate_pct, method, max_amount_toea, max_term_months
       FROM loan_products WHERE active = TRUE ORDER BY annual_rate_pct, name`);
  res.json({
    products: products.rows.map((p) => ({
      name: p.name, description: p.description, annualRatePct: Number(p.annual_rate_pct), method: p.method,
      maxAmount: Number(p.max_amount_toea), maxTermMonths: p.max_term_months,
    })),
    societyName: s.society_name || society(),
    savingsInterestRatePct: s.savings_interest_rate_pct,
    loanInterestRatePct: s.loan_interest_rate_pct,
    loanMethod: s.loan_method,
    maxTermMonths: s.loan_max_term_months,
    currency: s.currency,
  });
}));

// ---- Public: membership request form ----
router.post('/public/membership-requests', throttle, wrap(async (req, res) => {
  const b = req.body || {};
  const fullName = String(b.fullName || '').trim().slice(0, 150);
  const email = normaliseEmail(b.email);
  if (fullName.length < 2) throw httpError(400, 'Please enter your full name');
  if (!EMAIL.test(email)) throw httpError(400, 'Please enter a valid email address');
  const phone = b.phone ? String(b.phone).trim().slice(0, 40) : null;
  const village = b.village ? String(b.village).trim().slice(0, 120) : null;
  const message = b.message ? String(b.message).trim().slice(0, 1000) : null;

  const { rows } = await query(
    `INSERT INTO membership_requests (full_name, email, phone, village, message)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`, [fullName, email, phone, village, message]);

  await notify({ to: email, ...membershipReceivedEmail({ name: fullName }) });
  const admins = await query(`SELECT email FROM users WHERE role = 'admin' AND active = TRUE`);
  for (const a of admins.rows) {
    await notify({ to: a.email, ...adminNewRequestEmail({ name: fullName, phone, village, link: `${appUrl()}/app/onboarding` }) });
  }
  res.status(201).json({ id: rows[0].id, message: 'Thank you. Your request has been received.' });
}));

// ---- Staff: review membership requests ----
router.get('/membership-requests', authenticate, requireRole('admin', 'officer'), wrap(async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const { rows } = await query(
    `SELECT * FROM membership_requests WHERE ($1::text IS NULL OR status = $1) ORDER BY created_at DESC LIMIT 300`,
    [status]);
  res.json(rows.map((r) => ({
    id: r.id, fullName: r.full_name, email: r.email, phone: r.phone, village: r.village, message: r.message,
    status: r.status, createdAt: r.created_at, decidedAt: r.decided_at, declineReason: r.decline_reason,
  })));
}));

router.post('/membership-requests/:id/approve', authenticate, requireRole('admin', 'officer'), wrap(async (req, res) => {
  const r = await query(`SELECT * FROM membership_requests WHERE id = $1 AND status = 'pending'`, [req.params.id]);
  const request = r.rows[0];
  if (!request) throw httpError(400, 'Only pending requests can be approved');

  // Create the member record, then invite the applicant to their own portal account.
  const member = await withTransaction(async (c) => {
    const m = await c.query(
      `INSERT INTO members (member_no, full_name, phone, email, village)
       VALUES ('M' || nextval('member_no_seq'), $1, $2, $3, $4) RETURNING id`,
      [request.full_name, request.phone, request.email, request.village]);
    await c.query(
      `UPDATE membership_requests SET status='approved', member_id=$2, decided_at=now(), decided_by=$3 WHERE id=$1`,
      [request.id, m.rows[0].id, req.user.sub]);
    await audit(req.user, 'membership.approve', 'membership_request', request.id, { memberId: m.rows[0].id }, c);
    return m.rows[0];
  });

  const invite = await createInvitation({
    email: request.email, role: 'member', fullName: request.full_name, memberId: member.id, invitedBy: req.user.sub,
  });
  await notify({ to: request.email, ...membershipDecisionEmail({ name: request.full_name, approved: true }) });
  res.status(201).json({ memberId: member.id, invitation: invite });
}));

router.post('/membership-requests/:id/decline', authenticate, requireRole('admin', 'officer'), wrap(async (req, res) => {
  const reason = req.body?.reason ? String(req.body.reason).slice(0, 500) : null;
  const { rows } = await query(
    `UPDATE membership_requests SET status='declined', decline_reason=$2, decided_at=now(), decided_by=$3
      WHERE id=$1 AND status='pending' RETURNING full_name, email`,
    [req.params.id, reason, req.user.sub]);
  if (!rows[0]) throw httpError(400, 'Only pending requests can be declined');
  await audit(req.user, 'membership.decline', 'membership_request', req.params.id, { reason });
  await notify({ to: rows[0].email, ...membershipDecisionEmail({ name: rows[0].full_name, approved: false, reason }) });
  res.json({ ok: true });
}));

// ---- Staff: notification log, so failed emails can be seen and resent ----
router.get('/notifications', authenticate, requireRole('admin'), wrap(async (req, res) => {
  const { rows } = await query(`SELECT * FROM notifications ORDER BY created_at DESC LIMIT 200`);
  res.json(rows.map((n) => ({ id: n.id, to: n.to_email, subject: n.subject, status: n.status, error: n.error, createdAt: n.created_at })));
}));

export default router;
