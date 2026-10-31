import { Router } from 'express';
import { query, withTransaction } from '../db/index.js';
import { authenticate, requireRole, httpError } from '../middleware/auth.js';
import { wrap, audit, toeaFromRequest, isStaff, isoDate, addMonths } from '../lib/http.js';
import { loanSchedule, outstandingBalance, arrearsOf, maxLoanAmount } from '../lib/finance.js';
import { getSettings } from '../lib/settings-store.js';
import { notify } from '../lib/notify.js';
import { loanUpdateEmail } from '../lib/templates.js';
import { applyRepayment, fundedTotal } from '../lib/loanOps.js';

const router = Router();
router.use(authenticate);

const shapeLoan = (r) => ({
  id: r.id,
  loanNo: r.loan_no,
  memberId: r.member_id,
  memberName: r.member_name,
  memberNo: r.member_no,
  guarantorId: r.guarantor_id,
  productId: r.product_id,
  productName: r.product_name,
  principal: Number(r.principal_toea),
  funded: Number(r.funded),
  annualRatePct: Number(r.annual_rate_pct),
  termMonths: r.term_months,
  method: r.method,
  purpose: r.purpose,
  status: r.status,
  appliedAt: r.applied_at,
  approvedAt: r.approved_at,
  disbursedAt: r.disbursed_at,
  rejectionReason: r.rejection_reason,
});

const LOAN_SELECT = `
  SELECT l.*, m.full_name AS member_name, m.member_no, m.village, p.name AS product_name,
         (SELECT COALESCE(SUM(li.amount_toea),0)::bigint FROM loan_investments li WHERE li.loan_id = l.id) AS funded
    FROM loans l
    JOIN members m ON m.id = l.member_id
    LEFT JOIN loan_products p ON p.id = l.product_id`;

/** Savings + share capital for a member, in toea. */
async function savingsAndShares(db, memberId) {
  const r = await db.query(
    `SELECT
       COALESCE((SELECT SUM(CASE WHEN type='subscription' THEN amount_toea ELSE -amount_toea END)
                 FROM share_transactions WHERE member_id = $1), 0)::bigint AS shares,
       COALESCE((SELECT SUM(CASE WHEN t.type='withdrawal' THEN -t.amount_toea ELSE t.amount_toea END)
                 FROM savings_transactions t
                 JOIN savings_accounts a ON a.id = t.account_id WHERE a.member_id = $1), 0)::bigint AS savings`,
    [memberId]);
  return Number(r.rows[0].shares) + Number(r.rows[0].savings);
}

async function activeProduct(db, productId) {
  const r = await db.query('SELECT * FROM loan_products WHERE id = $1 AND active = TRUE', [productId]);
  if (!r.rows[0]) throw httpError(400, 'Please choose an available loan product');
  return r.rows[0];
}

// Email the member about a loan event. Failures are recorded, never thrown.
async function emailMemberAboutLoan(loanId, details) {
  const r = await query(
    `SELECT l.loan_no, l.principal_toea, m.full_name, m.email
       FROM loans l JOIN members m ON m.id = l.member_id WHERE l.id = $1`, [loanId]);
  const loan = r.rows[0];
  if (!loan?.email) return;
  await notify({
    to: loan.email,
    ...loanUpdateEmail({ name: loan.full_name, loanNo: loan.loan_no, principal: loan.principal_toea, ...details }),
  });
}

// Eligibility check for a given product, shown before applying.
router.get('/eligibility/:memberId', wrap(async (req, res) => {
  if (!isStaff(req.user) && req.user.memberId !== req.params.memberId) throw httpError(403, 'Not allowed');
  const s = await getSettings();
  const base = await savingsAndShares({ query }, req.params.memberId);
  const product = req.query.productId ? await activeProduct({ query }, req.query.productId).catch(() => null) : null;
  const caps = [product && Number(product.max_amount_toea), s.loan_max_amount_toea].filter((v) => v > 0);
  const max = maxLoanAmount({
    savingsAndSharesToea: base,
    multiple: s.loan_max_multiple,
    cap: caps.length ? Math.min(...caps) : 0,
  });
  res.json({
    savingsAndShares: base,
    maxLoan: max,
    maxTermMonths: product ? product.max_term_months : s.loan_max_term_months,
    annualRatePct: product ? Number(product.annual_rate_pct) : s.loan_interest_rate_pct,
    requireGuarantor: s.require_guarantor,
  });
}));

router.get('/', wrap(async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const memberId = isStaff(req.user) ? (req.query.memberId || null) : req.user.memberId;
  const { rows } = await query(
    `${LOAN_SELECT} WHERE ($1::text IS NULL OR l.status = $1) AND ($2::uuid IS NULL OR l.member_id = $2)
     ORDER BY l.applied_at DESC LIMIT 500`,
    [status, memberId]);
  res.json(rows.map(shapeLoan));
}));

router.post('/', wrap(async (req, res) => {
  const b = req.body || {};
  if (!isStaff(req.user) && req.user.role !== 'member') throw httpError(403, 'Not allowed');
  if (!isStaff(req.user) && b.memberId && b.memberId !== req.user.memberId) {
    throw httpError(403, 'You can only apply for a loan in your own name');
  }
  const memberId = isStaff(req.user) ? b.memberId : req.user.memberId;
  if (!memberId) throw httpError(400, 'memberId is required');
  const principal = toeaFromRequest(b.amount, 'Loan amount');
  const termMonths = Number.parseInt(b.termMonths, 10);
  if (!Number.isInteger(termMonths) || termMonths <= 0) throw httpError(400, 'Term must be a whole number of months');

  const product = await activeProduct({ query }, b.productId);
  if (termMonths > product.max_term_months) throw httpError(400, `Maximum term for ${product.name} is ${product.max_term_months} months`);
  if (principal > Number(product.max_amount_toea)) throw httpError(400, `Maximum for ${product.name} is K${(Number(product.max_amount_toea) / 100).toLocaleString('en-US')}`);

  const s = await getSettings();
  const base = await savingsAndShares({ query }, memberId);
  const max = maxLoanAmount({ savingsAndSharesToea: base, multiple: s.loan_max_multiple, cap: 0 });
  if (principal > max) throw httpError(400, 'Amount exceeds the maximum loan for this member based on savings');

  if (s.require_guarantor) {
    if (!b.guarantorId || b.guarantorId === memberId) throw httpError(400, 'A guarantor is required');
    const g = await savingsAndShares({ query }, b.guarantorId);
    if (g < s.guarantor_min_savings_toea) throw httpError(400, 'Guarantor does not meet the minimum savings requirement');
  }

  const { rows } = await withTransaction(async (c) => {
    const r = await c.query(
      `INSERT INTO loans (loan_no, member_id, guarantor_id, product_id, principal_toea, annual_rate_pct, term_months, method, purpose)
       VALUES ('L' || nextval('loan_no_seq'), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, loan_no`,
      [memberId, b.guarantorId || null, product.id, principal, product.annual_rate_pct, termMonths, product.method,
       b.purpose ? String(b.purpose).slice(0, 500) : null]);
    await audit(req.user, 'loan.apply', 'loan', r.rows[0].id, { principal, termMonths, product: product.name }, c);
    return r;
  });
  res.status(201).json({ id: rows[0].id, loanNo: rows[0].loan_no });
}));

router.get('/arrears', requireRole('admin', 'officer', 'cashier', 'auditor'), wrap(async (req, res) => {
  const today = isoDate();
  const { rows } = await query(
    `SELECT i.*, l.loan_no, l.status, m.full_name AS member_name, m.member_no
       FROM loan_installments i JOIN loans l ON l.id = i.loan_id JOIN members m ON m.id = l.member_id
      WHERE l.status = 'disbursed' AND i.due_date < $1
        AND i.principal_paid + i.interest_paid < i.principal_due + i.interest_due
      ORDER BY i.due_date`, [today]);
  res.json(rows.map((r) => ({
    loanId: r.loan_id, loanNo: r.loan_no, memberName: r.member_name, memberNo: r.member_no,
    period: r.period, dueDate: r.due_date,
    amountOverdue: Number(r.principal_due + r.interest_due - r.principal_paid - r.interest_paid),
  })));
}));

router.get('/:id', wrap(async (req, res) => {
  const { rows } = await query(`${LOAN_SELECT} WHERE l.id = $1`, [req.params.id]);
  const loan = rows[0];
  if (!loan) throw httpError(404, 'Loan not found');
  const borrower = loan.member_id === req.user.memberId;
  const staff = isStaff(req.user);
  if (!staff && !borrower) {
    // Other members may see only loans open for funding (comparison), and never the borrower's identity.
    const investor = await query('SELECT 1 FROM loan_investments WHERE loan_id = $1 AND member_id = $2', [loan.id, req.user.memberId]);
    if (!investor.rowCount && loan.status !== 'approved') throw httpError(403, 'Not your loan');
    loan.member_name = loan.village ? `Borrower from ${loan.village}` : 'Borrower';
    loan.member_no = null;
  }

  const inst = await query('SELECT * FROM loan_installments WHERE loan_id = $1 ORDER BY period', [loan.id]);
  const rep = await query('SELECT id, amount_toea, paid_on, source FROM loan_repayments WHERE loan_id = $1 ORDER BY paid_on, created_at', [loan.id]);
  const investors = await query(
    `SELECT li.amount_toea, li.created_at, m.full_name, m.member_no FROM loan_investments li
       JOIN members m ON m.id = li.member_id WHERE li.loan_id = $1 ORDER BY li.created_at`, [loan.id]);

  const installments = inst.rows.map((i) => ({
    period: i.period, dueDate: i.due_date,
    principalDue: Number(i.principal_due), interestDue: Number(i.interest_due),
    principalPaid: Number(i.principal_paid), interestPaid: Number(i.interest_paid),
  }));
  res.json({
    ...shapeLoan(loan),
    installments,
    repayments: rep.rows.map((r) => ({ id: r.id, amount: Number(r.amount_toea), paidOn: r.paid_on, source: r.source })),
    outstanding: outstandingBalance(inst.rows),
    arrears: arrearsOf(inst.rows, isoDate()).length,
    investorCount: investors.rowCount,
    investors: staff
      ? investors.rows.map((i) => ({ name: i.full_name, memberNo: i.member_no, amount: Number(i.amount_toea), at: i.created_at }))
      : undefined,
  });
}));

router.post('/:id/approve', requireRole('admin'), wrap(async (req, res) => {
  const { rows } = await query(
    `UPDATE loans SET status='approved', approved_at=now(), approved_by=$2
      WHERE id=$1 AND status='applied' RETURNING id`, [req.params.id, req.user.sub]);
  if (!rows[0]) throw httpError(400, 'Only applied loans can be approved');
  await audit(req.user, 'loan.approve', 'loan', req.params.id);
  await emailMemberAboutLoan(req.params.id, { status: 'approved' });
  res.json({ ok: true });
}));

router.post('/:id/reject', requireRole('admin'), wrap(async (req, res) => {
  const { rows } = await query(
    `UPDATE loans SET status='rejected', rejection_reason=$2 WHERE id=$1 AND status='applied' RETURNING id`,
    [req.params.id, String(req.body?.reason || '').slice(0, 500) || null]);
  if (!rows[0]) throw httpError(400, 'Only applied loans can be rejected');
  await audit(req.user, 'loan.reject', 'loan', req.params.id, { reason: req.body?.reason });
  await emailMemberAboutLoan(req.params.id, { status: 'rejected', reason: req.body?.reason });
  res.json({ ok: true });
}));

// Disbursement needs the loan to be fully funded by members. It then creates the repayment schedule.
router.post('/:id/disburse', requireRole('admin'), wrap(async (req, res) => {
  const disbursedOn = isoDate(req.body?.disbursedOn);
  await withTransaction(async (c) => {
    const l = await c.query('SELECT * FROM loans WHERE id = $1 FOR UPDATE', [req.params.id]);
    const loan = l.rows[0];
    if (!loan) throw httpError(404, 'Loan not found');
    if (loan.status !== 'approved') throw httpError(400, 'Only approved loans can be disbursed');
    const funded = await fundedTotal(c, loan.id);
    if (funded < Number(loan.principal_toea)) {
      throw httpError(400, `Loan is not fully funded yet (${funded} of ${loan.principal_toea} toea)`);
    }

    const rows = loanSchedule({
      principal: Number(loan.principal_toea),
      annualRatePct: Number(loan.annual_rate_pct),
      termMonths: loan.term_months,
      method: loan.method,
    });
    for (const r of rows) {
      await c.query(
        `INSERT INTO loan_installments (loan_id, period, due_date, principal_due, interest_due)
         VALUES ($1,$2,$3,$4,$5)`,
        [loan.id, r.period, addMonths(disbursedOn, r.period), r.principal, r.interest]);
    }
    await c.query(`UPDATE loans SET status='disbursed', disbursed_at=$2, disbursed_by=$3 WHERE id=$1`,
      [loan.id, disbursedOn, req.user.sub]);
    await audit(req.user, 'loan.disburse', 'loan', loan.id, { disbursedOn }, c);
  });
  await emailMemberAboutLoan(req.params.id, { status: 'disbursed' });
  res.json({ ok: true });
}));

router.post('/:id/repayments', requireRole('admin', 'cashier'), wrap(async (req, res) => {
  const amount = toeaFromRequest(req.body?.amount, 'Repayment amount');
  const paidOn = isoDate(req.body?.paidOn);
  const result = await withTransaction((c) => applyRepayment(c, {
    loanId: req.params.id, amount, paidOn, actor: req.user, source: 'cash',
  }));
  await emailMemberAboutLoan(req.params.id, {
    kind: 'repayment', principal: result.applied, outstanding: result.outstanding, paidOn,
  });
  res.status(201).json({ applied: result.applied, outstanding: result.outstanding, closed: result.closed });
}));

export default router;
