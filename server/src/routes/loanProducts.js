import { Router } from 'express';
import { query } from '../db/index.js';
import { authenticate, requireRole, httpError } from '../middleware/auth.js';
import { wrap, audit, toeaFromRequest } from '../lib/http.js';

const router = Router();
router.use(authenticate);

const shape = (p) => ({
  id: p.id,
  name: p.name,
  description: p.description,
  annualRatePct: Number(p.annual_rate_pct),
  method: p.method,
  maxAmount: Number(p.max_amount_toea),
  maxTermMonths: p.max_term_months,
  active: p.active,
});

// Members see active products only; staff see all of them.
router.get('/', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM loan_products WHERE ($1 OR active = TRUE) ORDER BY annual_rate_pct, name`,
    [req.user.role !== 'member']);
  res.json(rows.map(shape));
}));

router.post('/', requireRole('admin'), wrap(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (name.length < 3) throw httpError(400, 'Product name is required');
  const rate = Number(b.annualRatePct);
  if (!(rate >= 0 && rate <= 100)) throw httpError(400, 'Interest rate must be between 0 and 100');
  const method = b.method === 'flat' ? 'flat' : 'reducing';
  const maxAmount = toeaFromRequest(b.maxAmount, 'Maximum amount');
  const maxTerm = Number.parseInt(b.maxTermMonths, 10);
  if (!(maxTerm > 0 && maxTerm <= 120)) throw httpError(400, 'Maximum term must be between 1 and 120 months');
  try {
    const { rows } = await query(
      `INSERT INTO loan_products (name, description, annual_rate_pct, method, max_amount_toea, max_term_months)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name, b.description ? String(b.description).slice(0, 500) : null, rate, method, maxAmount, maxTerm]);
    await audit(req.user, 'loan_product.create', 'loan_product', rows[0].id, { name });
    res.status(201).json(shape(rows[0]));
  } catch (err) {
    if (err.code === '23505') throw httpError(409, 'A product with this name already exists');
    throw err;
  }
}));

// Changing a product affects new applications only. Existing loans keep their agreed terms.
router.patch('/:id', requireRole('admin'), wrap(async (req, res) => {
  const b = req.body || {};
  const sets = [];
  const vals = [];
  const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if ('active' in b) add('active', Boolean(b.active));
  if ('description' in b) add('description', b.description ? String(b.description).slice(0, 500) : null);
  if ('annualRatePct' in b) {
    const rate = Number(b.annualRatePct);
    if (!(rate >= 0 && rate <= 100)) throw httpError(400, 'Interest rate must be between 0 and 100');
    add('annual_rate_pct', rate);
  }
  if ('maxAmount' in b) add('max_amount_toea', toeaFromRequest(b.maxAmount, 'Maximum amount'));
  if ('maxTermMonths' in b) {
    const t = Number.parseInt(b.maxTermMonths, 10);
    if (!(t > 0 && t <= 120)) throw httpError(400, 'Maximum term must be between 1 and 120 months');
    add('max_term_months', t);
  }
  if (!sets.length) throw httpError(400, 'Nothing to update');
  vals.push(req.params.id);
  const { rows } = await query(`UPDATE loan_products SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
  if (!rows[0]) throw httpError(404, 'Product not found');
  await audit(req.user, 'loan_product.update', 'loan_product', req.params.id, b);
  res.json(shape(rows[0]));
}));

export default router;
