import { Router } from 'express';
import { query, withTransaction } from '../db/index.js';
import { authenticate, requireRole, httpError } from '../middleware/auth.js';
import { wrap, audit, toeaFromRequest, isoDate } from '../lib/http.js';

const router = Router();
router.use(authenticate);

const CATEGORIES = ['property', 'shares', 'business', 'fixed_deposit', 'agriculture', 'other'];

router.get('/', requireRole('admin', 'officer', 'cashier', 'auditor'), wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT i.*,
       COALESCE((SELECT SUM(amount_toea) FROM investment_income x WHERE x.investment_id = i.id AND x.kind='return'),0)::bigint AS returns_total,
       COALESCE((SELECT SUM(amount_toea) FROM investment_income x WHERE x.investment_id = i.id AND x.kind='distribution'),0)::bigint AS distributions_total
     FROM investments i ORDER BY i.invested_on DESC`);
  res.json(rows.map((r) => ({
    id: r.id, name: r.name, category: r.category, principal: Number(r.principal_toea),
    expectedAnnualReturnPct: Number(r.expected_annual_return_pct), investedOn: r.invested_on,
    status: r.status, notes: r.notes,
    returnsReceived: Number(r.returns_total), distributed: Number(r.distributions_total),
  })));
}));

router.post('/', requireRole('admin'), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.name || String(b.name).trim().length < 2) throw httpError(400, 'Investment name is required');
  const principal = toeaFromRequest(b.principal, 'Principal');
  const rate = Number(b.expectedAnnualReturnPct ?? 0);
  if (!(rate >= 0 && rate < 100)) throw httpError(400, 'Expected return must be between 0 and 100');
  const category = CATEGORIES.includes(b.category) ? b.category : 'other';
  const { rows } = await withTransaction(async (c) => {
    const r = await c.query(
      `INSERT INTO investments (name, category, principal_toea, expected_annual_return_pct, invested_on, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [String(b.name).trim(), category, principal, rate, isoDate(b.investedOn), b.notes || null]);
    await audit(req.user, 'investment.create', 'investment', r.rows[0].id, { principal }, c);
    return r;
  });
  res.status(201).json({ id: rows[0].id });
}));

router.post('/:id/income', requireRole('admin'), wrap(async (req, res) => {
  const kind = req.body?.kind === 'distribution' ? 'distribution' : 'return';
  const amount = toeaFromRequest(req.body?.amount, 'Amount');
  await withTransaction(async (c) => {
    const inv = await c.query('SELECT id FROM investments WHERE id = $1', [req.params.id]);
    if (!inv.rows[0]) throw httpError(404, 'Investment not found');
    await c.query(
      'INSERT INTO investment_income (investment_id, kind, amount_toea, received_on) VALUES ($1,$2,$3,$4)',
      [req.params.id, kind, amount, isoDate(req.body?.receivedOn)]);
    await audit(req.user, `investment.${kind}`, 'investment', req.params.id, { amount }, c);
  });
  res.status(201).json({ ok: true });
}));

router.patch('/:id/status', requireRole('admin'), wrap(async (req, res) => {
  const status = String(req.body?.status || '');
  if (!['active', 'matured', 'sold', 'lost'].includes(status)) throw httpError(400, 'Invalid status');
  const { rows } = await query('UPDATE investments SET status=$2 WHERE id=$1 RETURNING id', [req.params.id, status]);
  if (!rows[0]) throw httpError(404, 'Investment not found');
  await audit(req.user, 'investment.status', 'investment', req.params.id, { status });
  res.json({ ok: true });
}));

export default router;
