import { Router } from 'express';
import { query, withTransaction } from '../db/index.js';
import { authenticate, requireRole, httpError } from '../middleware/auth.js';
import { wrap, audit, toeaFromRequest, isStaff } from '../lib/http.js';
import { monthlySavingsInterest } from '../lib/finance.js';
import { getSettings } from '../lib/settings-store.js';

const router = Router();
router.use(authenticate);

const BALANCE_SQL = `COALESCE(SUM(CASE WHEN type='withdrawal' THEN -amount_toea ELSE amount_toea END),0)::bigint`;

router.get('/accounts', wrap(async (req, res) => {
  const memberId = isStaff(req.user) ? req.query.memberId || null : req.user.memberId;
  const { rows } = await query(
    `SELECT a.id, a.account_no, a.member_id, a.product, a.status, a.opened_on, m.full_name, m.member_no,
            (SELECT ${BALANCE_SQL} FROM savings_transactions t WHERE t.account_id = a.id) AS balance
       FROM savings_accounts a JOIN members m ON m.id = a.member_id
      WHERE ($1::uuid IS NULL OR a.member_id = $1)
      ORDER BY a.account_no`,
    [memberId],
  );
  res.json(rows.map((r) => ({
    id: r.id, accountNo: r.account_no, memberId: r.member_id, memberName: r.full_name,
    memberNo: r.member_no, product: r.product, status: r.status, openedOn: r.opened_on, balance: Number(r.balance),
  })));
}));

router.post('/accounts', requireRole('admin', 'officer'), wrap(async (req, res) => {
  const { memberId, product = 'Regular Savings' } = req.body || {};
  if (!memberId) throw httpError(400, 'memberId is required');
  const { rows } = await withTransaction(async (c) => {
    const m = await c.query('SELECT id FROM members WHERE id = $1', [memberId]);
    if (!m.rows[0]) throw httpError(404, 'Member not found');
    const r = await c.query(
      `INSERT INTO savings_accounts (account_no, member_id, product)
       VALUES ('S' || nextval('account_no_seq'), $1, $2) RETURNING id, account_no`,
      [memberId, product]);
    await audit(req.user, 'savings.open', 'savings_account', r.rows[0].id, { memberId, product }, c);
    return r;
  });
  res.status(201).json({ id: rows[0].id, accountNo: rows[0].account_no });
}));

router.get('/accounts/:id', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT a.*, m.full_name, m.member_no FROM savings_accounts a JOIN members m ON m.id = a.member_id WHERE a.id = $1`,
    [req.params.id]);
  const acc = rows[0];
  if (!acc) throw httpError(404, 'Account not found');
  if (!isStaff(req.user) && acc.member_id !== req.user.memberId) throw httpError(403, 'Not your account');

  const tx = await query(
    `SELECT id, type, amount_toea, reference, period, created_at FROM savings_transactions
      WHERE account_id = $1 ORDER BY created_at DESC LIMIT 200`, [req.params.id]);
  const bal = await query(`SELECT ${BALANCE_SQL} AS b FROM savings_transactions WHERE account_id = $1`, [req.params.id]);
  res.json({
    id: acc.id, accountNo: acc.account_no, product: acc.product, status: acc.status, openedOn: acc.opened_on,
    memberId: acc.member_id, memberName: acc.full_name, memberNo: acc.member_no,
    balance: Number(bal.rows[0].b),
    transactions: tx.rows.map((t) => ({ id: t.id, type: t.type, amount: Number(t.amount_toea),
      reference: t.reference, period: t.period, createdAt: t.created_at })),
  });
}));

router.post('/accounts/:id/transactions', requireRole('admin', 'officer'), wrap(async (req, res) => {
  const amount = toeaFromRequest(req.body?.amount, 'Amount');
  const type = req.body?.type === 'withdrawal' ? 'withdrawal' : 'deposit';
  const reference = req.body?.reference ? String(req.body.reference).slice(0, 200) : null;
  const settings = await getSettings();

  const balance = await withTransaction(async (c) => {
    // Lock the account row so two withdrawals cannot overdraw it at the same time.
    const acc = await c.query('SELECT id, status FROM savings_accounts WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!acc.rows[0]) throw httpError(404, 'Account not found');
    if (acc.rows[0].status !== 'open') throw httpError(400, `Account is ${acc.rows[0].status}`);

    const cur = await c.query(`SELECT ${BALANCE_SQL} AS b FROM savings_transactions WHERE account_id = $1`, [req.params.id]);
    const current = Number(cur.rows[0].b);
    if (type === 'withdrawal' && current - amount < settings.min_savings_balance_toea) {
      throw httpError(400, 'Withdrawal would take the account below the minimum balance');
    }
    await c.query(
      `INSERT INTO savings_transactions (account_id, type, amount_toea, reference, created_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [req.params.id, type, amount, reference, req.user.sub]);
    await audit(req.user, `savings.${type}`, 'savings_account', req.params.id, { amount, reference }, c);
    return type === 'withdrawal' ? current - amount : current + amount;
  });
  res.status(201).json({ balance });
}));

// Monthly interest run. Idempotent: an account is credited once per period.
router.post('/interest-run', requireRole('admin'), wrap(async (req, res) => {
  const period = String(req.body?.period || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw httpError(400, 'period must look like 2026-10');
  const settings = await getSettings();
  const accounts = await query(
    `SELECT a.id, (SELECT ${BALANCE_SQL} FROM savings_transactions t WHERE t.account_id = a.id) AS balance
       FROM savings_accounts a WHERE a.status = 'open'`);

  let credited = 0;
  let total = 0;
  await withTransaction(async (c) => {
    for (const a of accounts.rows) {
      const interest = monthlySavingsInterest(Number(a.balance), settings.savings_interest_rate_pct);
      if (interest <= 0) continue;
      const r = await c.query(
        `INSERT INTO savings_transactions (account_id, type, amount_toea, reference, period, created_by)
         VALUES ($1,'interest',$2,$3,$4,$5) ON CONFLICT (account_id, type, period) DO NOTHING RETURNING id`,
        [a.id, interest, `Interest ${period}`, period, req.user.sub]);
      if (r.rowCount) { credited += 1; total += interest; }
    }
    await audit(req.user, 'savings.interest_run', 'period', period, { credited, total }, c);
  });
  res.json({ period, accountsCredited: credited, totalInterest: total });
}));

export default router;
