// Member investment products: fixed deposits, project shares, agriculture shares and property.
// These are separate from loan investments (which fund specific loans).
import { Router } from 'express';
import { query, withTransaction } from '../db/index.js';
import { authenticate, requireRole, httpError } from '../middleware/auth.js';
import { wrap, audit, toeaFromRequest, isoDate, addMonths } from '../lib/http.js';
import { debitSavings, creditSavingsOrEarnings } from '../lib/loanOps.js';
import { payMaturedFixedDeposits } from '../lib/jobs.js';

const router = Router();
router.use(authenticate);

const KINDS = ['fixed_deposit', 'project_shares', 'agri_shares', 'property'];
const KIND_LABEL = {
  fixed_deposit: 'Fixed deposit', project_shares: 'Project or business shares',
  agri_shares: 'Agriculture co-operative shares', property: 'Property or land',
};
const shape = (p) => ({
  id: p.id, name: p.name, kind: p.kind, kindLabel: KIND_LABEL[p.kind], description: p.description,
  annualRatePct: Number(p.annual_rate_pct), termMonths: p.term_months, minAmount: Number(p.min_amount_toea),
  status: p.status,
});

router.get('/', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM investment_products WHERE ($1 OR status = 'open') ORDER BY kind, name`,
    [req.user.role !== 'member']);
  res.json(rows.map(shape));
}));

router.post('/', requireRole('admin'), wrap(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (name.length < 3) throw httpError(400, 'Name is required');
  if (!KINDS.includes(b.kind)) throw httpError(400, 'Choose a product type');
  const rate = Number(b.annualRatePct ?? 0);
  if (!(rate >= 0 && rate <= 100)) throw httpError(400, 'Rate must be between 0 and 100');
  const term = b.kind === 'fixed_deposit' ? Number.parseInt(b.termMonths, 10) : null;
  if (b.kind === 'fixed_deposit' && !(term > 0 && term <= 120)) throw httpError(400, 'A fixed deposit needs a term between 1 and 120 months');
  const min = b.minAmount ? toeaFromRequest(b.minAmount, 'Minimum amount') : 0;
  try {
    const { rows } = await query(
      `INSERT INTO investment_products (name, kind, description, annual_rate_pct, term_months, min_amount_toea)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name, b.kind, b.description ? String(b.description).slice(0, 500) : null, rate, term, min]);
    await audit(req.user, 'investment_product.create', 'investment_product', rows[0].id, { name, kind: b.kind });
    res.status(201).json(shape(rows[0]));
  } catch (err) {
    if (err.code === '23505') throw httpError(409, 'A product with this name already exists');
    throw err;
  }
}));

router.patch('/:id', requireRole('admin'), wrap(async (req, res) => {
  const b = req.body || {};
  const { rows } = await query(
    `UPDATE investment_products SET
        status = COALESCE($2, status),
        annual_rate_pct = COALESCE($3, annual_rate_pct),
        description = COALESCE($4, description)
      WHERE id = $1 RETURNING *`,
    [req.params.id, b.status && ['open', 'closed'].includes(b.status) ? b.status : null,
     b.annualRatePct != null ? Number(b.annualRatePct) : null, b.description ?? null]);
  if (!rows[0]) throw httpError(404, 'Product not found');
  await audit(req.user, 'investment_product.update', 'investment_product', req.params.id, b);
  res.json(shape(rows[0]));
}));

// Member buys a product from one of their savings accounts.
router.post('/:id/invest', requireRole('member'), wrap(async (req, res) => {
  const amount = toeaFromRequest(req.body?.amount, 'Amount');
  const savingsAccountId = req.body?.savingsAccountId;
  if (!savingsAccountId) throw httpError(400, 'Choose the savings account to invest from');
  const memberId = req.user.memberId;

  const result = await withTransaction(async (c) => {
    const p = await c.query('SELECT * FROM investment_products WHERE id = $1', [req.params.id]);
    const product = p.rows[0];
    if (!product || product.status !== 'open') throw httpError(400, 'This product is not open for investment');
    if (amount < Number(product.min_amount_toea)) throw httpError(400, `Minimum amount is K${(Number(product.min_amount_toea) / 100).toLocaleString('en-US')}`);

    const today = isoDate();
    const maturity = product.kind === 'fixed_deposit' ? addMonths(today, product.term_months) : null;
    await debitSavings(c, { accountId: savingsAccountId, memberId, amount, reference: `Invest: ${product.name}`, actor: req.user });
    const inv = await c.query(
      `INSERT INTO member_investments (product_id, member_id, savings_account_id, principal_toea, rate_pct, start_on, maturity_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [product.id, memberId, savingsAccountId, amount, product.annual_rate_pct, today, maturity]);
    await audit(req.user, 'investment.buy', 'investment_product', product.id, { amount, maturity }, c);
    return { id: inv.rows[0].id, maturityOn: maturity };
  });
  res.status(201).json(result);
}));

// Member's own positions across all products.
router.get('/positions', requireRole('member'), wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT mi.id, mi.principal_toea, mi.rate_pct, mi.start_on, mi.maturity_on, mi.status, p.name, p.kind,
            COALESCE((SELECT SUM(amount_toea) FROM member_investment_income x WHERE x.member_investment_id = mi.id),0)::bigint AS income
       FROM member_investments mi JOIN investment_products p ON p.id = mi.product_id
      WHERE mi.member_id = $1 ORDER BY mi.start_on DESC`, [req.user.memberId]);
  res.json(rows.map((r) => ({
    id: r.id, productName: r.name, kind: r.kind, kindLabel: KIND_LABEL[r.kind],
    principal: Number(r.principal_toea), ratePct: Number(r.rate_pct), startOn: r.start_on, maturityOn: r.maturity_on,
    status: r.status, incomeReceived: Number(r.income),
  })));
}));

// Declare a return for share or property products. It is shared pro-rata by holders.
router.post('/:id/distribute', requireRole('admin'), wrap(async (req, res) => {
  const amount = toeaFromRequest(req.body?.amount, 'Amount');
  const note = req.body?.note ? String(req.body.note).slice(0, 300) : null;
  const result = await withTransaction(async (c) => {
    const p = await c.query('SELECT * FROM investment_products WHERE id = $1', [req.params.id]);
    const product = p.rows[0];
    if (!product) throw httpError(404, 'Product not found');
    if (product.kind === 'fixed_deposit') throw httpError(400, 'Fixed deposits earn interest at maturity, not by distribution');

    const holders = await c.query(
      `SELECT mi.id, mi.member_id, mi.principal_toea, m.interest_destination
         FROM member_investments mi JOIN members m ON m.id = mi.member_id
        WHERE mi.product_id = $1 AND mi.status = 'active' ORDER BY mi.start_on, mi.id`, [product.id]);
    const total = holders.rows.reduce((s, h) => s + Number(h.principal_toea), 0);
    if (!holders.rowCount || total === 0) throw httpError(400, 'No one holds this product yet');

    const dist = await c.query(
      `INSERT INTO product_distributions (product_id, amount_toea, note, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
      [product.id, amount, note, req.user.sub]);
    let rest = amount;
    for (let i = 0; i < holders.rows.length; i++) {
      const h = holders.rows[i];
      const last = i === holders.rows.length - 1;
      const share = last ? rest : Math.floor((amount * Number(h.principal_toea)) / total);
      rest -= share;
      if (share <= 0) continue;
      await creditSavingsOrEarnings(c, {
        memberId: h.member_id, amount: share, type: 'interest', loanId: null,
        reference: `${product.name} return`, hold: h.interest_destination === 'hold',
      });
      await c.query(
        `INSERT INTO member_investment_income (member_investment_id, distribution_id, amount_toea, kind) VALUES ($1,$2,$3,'distribution')`,
        [h.id, dist.rows[0].id, share]);
    }
    await audit(req.user, 'investment_product.distribute', 'investment_product', product.id, { amount, holders: holders.rowCount }, c);
    return { holders: holders.rowCount, amount };
  });
  res.status(201).json(result);
}));

// Pay fixed deposits that have matured. Also runs automatically every 6 hours.
router.post('/process-maturities', requireRole('admin'), wrap(async (req, res) => {
  res.json(await payMaturedFixedDeposits());
}));

export default router;
