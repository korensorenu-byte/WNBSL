import { Router } from 'express';
import { query } from '../db/index.js';
import { authenticate, requireRole, httpError } from '../middleware/auth.js';
import { wrap, audit, isoDate } from '../lib/http.js';
import { DEFAULT_SETTINGS } from '../lib/settings.js';
import { getSettings, clearSettingsCache } from '../lib/settings-store.js';
import { arrearsOf } from '../lib/finance.js';

const router = Router();
router.use(authenticate);

// ---- Settings (rules) ----
router.get('/settings', wrap(async (req, res) => {
  res.json(await getSettings({ fresh: true }));
}));

router.put('/settings', requireRole('admin'), wrap(async (req, res) => {
  const body = req.body || {};
  const updates = Object.entries(body).filter(([k]) => k in DEFAULT_SETTINGS);
  if (!updates.length) throw httpError(400, 'No recognised settings supplied');
  for (const [key, value] of updates) {
    const expected = typeof DEFAULT_SETTINGS[key];
    if (typeof value !== expected) throw httpError(400, `${key} must be ${expected === 'number' ? 'a number' : expected}`);
    if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) throw httpError(400, `${key} must be zero or more`);
    if (key === 'loan_method' && !['reducing', 'flat'].includes(value)) throw httpError(400, 'loan_method must be reducing or flat');
    if (key === 'savings_interest_rate_pct' || key === 'loan_interest_rate_pct') {
      if (value > 100) throw httpError(400, `${key} cannot exceed 100`);
    }
  }
  for (const [key, value] of updates) {
    await query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)]);
  }
  clearSettingsCache();
  await audit(req.user, 'settings.update', 'settings', null, Object.fromEntries(updates));
  res.json(await getSettings({ fresh: true }));
}));

// ---- Users (staff logins and member portal accounts) ----
router.get('/users', requireRole('admin'), wrap(async (req, res) => {
  const { rows } = await query(
    'SELECT id, email, full_name, role, member_id, active FROM users ORDER BY full_name');
  res.json(rows.map((u) => ({ id: u.id, email: u.email, fullName: u.full_name, role: u.role, memberId: u.member_id, active: u.active })));
}));

// New accounts are created only through invitations (see routes/invitations.js).

router.patch('/users/:id', requireRole('admin'), wrap(async (req, res) => {
  if (req.params.id === req.user.sub && req.body?.active === false) {
    throw httpError(400, 'You cannot deactivate your own account');
  }
  const { rows } = await query('UPDATE users SET active = COALESCE($2, active) WHERE id = $1 RETURNING id',
    [req.params.id, typeof req.body?.active === 'boolean' ? req.body.active : null]);
  if (!rows[0]) throw httpError(404, 'User not found');
  await audit(req.user, 'user.update', 'user', req.params.id, { active: req.body?.active });
  res.json({ ok: true });
}));

// ---- Dashboard and reports ----
router.get('/reports/summary', requireRole('admin', 'officer', 'cashier', 'auditor'), wrap(async (req, res) => {
  const [members, shares, savings, loans, arrears, invest] = await Promise.all([
    query(`SELECT COUNT(*) FILTER (WHERE status='active')::int AS active, COUNT(*)::int AS total FROM members`),
    query(`SELECT COALESCE(SUM(CASE WHEN type='subscription' THEN amount_toea ELSE -amount_toea END),0)::bigint AS v FROM share_transactions`),
    query(`SELECT COALESCE(SUM(CASE WHEN type='withdrawal' THEN -amount_toea ELSE amount_toea END),0)::bigint AS v FROM savings_transactions`),
    query(`SELECT COUNT(*) FILTER (WHERE status='disbursed')::int AS active,
             COUNT(*) FILTER (WHERE status='applied')::int AS pending,
             COALESCE(SUM(principal_toea) FILTER (WHERE status='disbursed'),0)::bigint AS disbursed_principal
           FROM loans`),
    query(`SELECT i.due_date, i.principal_due, i.interest_due, i.principal_paid, i.interest_paid, l.id AS loan_id
             FROM loan_installments i JOIN loans l ON l.id = i.loan_id WHERE l.status = 'disbursed'`),
    query(`SELECT COALESCE(SUM(principal_toea),0)::bigint AS principal,
             COALESCE((SELECT SUM(amount_toea) FROM investment_income WHERE kind='return'),0)::bigint AS returns,
             COALESCE((SELECT SUM(amount_toea) FROM investment_income WHERE kind='distribution'),0)::bigint AS distributed
           FROM investments WHERE status='active'`),
  ]);

  const today = isoDate();
  const byLoan = new Map();
  for (const r of arrears.rows) {
    if (!byLoan.has(r.loan_id)) byLoan.set(r.loan_id, []);
    byLoan.get(r.loan_id).push({ ...r, id: r.loan_id });
  }
  let outstanding = 0;
  let overdueAmount = 0;
  let overdueLoans = 0;
  for (const list of byLoan.values()) {
    const unpaid = list.map((i) => ({ ...i, principal_due: i.principal_due, interest_due: i.interest_due }));
    outstanding += unpaid.reduce((s, i) => s + (i.principal_due - i.principal_paid) + (i.interest_due - i.interest_paid), 0);
    const late = arrearsOf(unpaid, today);
    if (late.length) {
      overdueLoans += 1;
      overdueAmount += late.reduce((s, i) => s + (i.principal_due - i.principal_paid) + (i.interest_due - i.interest_paid), 0);
    }
  }
  const portfolio = Number(loans.rows[0].disbursed_principal) || 0;

  res.json({
    members: { active: members.rows[0].active, total: members.rows[0].total },
    shareCapital: Number(shares.rows[0].v),
    savingsBalance: Number(savings.rows[0].v),
    loans: {
      active: loans.rows[0].active,
      pendingApplications: loans.rows[0].pending,
      disbursedPrincipal: portfolio,
      outstanding,
      overdueLoans,
      overdueAmount,
      parRatioPct: outstanding ? Math.round((overdueAmount / outstanding) * 10000) / 100 : 0,
    },
    investments: {
      activePrincipal: Number(invest.rows[0].principal),
      returnsReceived: Number(invest.rows[0].returns),
      distributed: Number(invest.rows[0].distributed),
    },
  });
}));

router.get('/audit', requireRole('admin', 'auditor'), wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT a.id, a.action, a.entity, a.entity_id, a.detail, a.created_at, u.email
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id ORDER BY a.created_at DESC LIMIT 300`);
  res.json(rows);
}));

export default router;
