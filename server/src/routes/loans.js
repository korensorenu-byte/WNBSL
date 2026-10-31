import { Router } from 'express';
import { query, withTransaction } from '../db/index.js';
import { authenticate, requireRole, httpError } from '../middleware/auth.js';
import { wrap, audit, toeaFromRequest, isStaff, isoDate, addMonths } from '../lib/http.js';
import {
  loanSchedule, allocateRepayment, outstandingBalance, arrearsOf, maxLoanAmount,
} from '../lib/finance.js';
import { getSettings } from '../lib/settings-store.js';
import { notify } from '../lib/notify.js';
import { loanUpdateEmail } from '../lib/templates.js';

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

const router = Router();
router.use(authenticate);

const BAL = `COALESCE(SUM(CASE WHEN type='withdrawal' THEN -amount_toea ELSE amount_toea END),0)::bigint`;

const shapeLoan = (r) => ({
  id: r.id,
  loanNo: r.loan_no,
  memberId: r.member_id,
  memberName: r.member_name,
  memberNo: r.member_no,
  guarantorId: r.guarantor_id,
  principal: Number(r.principal_toea),
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
  SELECT l.*, m.full_name AS member_name, m.member_no FROM loans l JOIN members m ON m.id = l.member_id`;

router.get('/', wrap(async (req, res) => {
  const status = req.query.status ? String(req.query.status) : null;
  const memberId = isStaff(req.user) ? (req.query.memberId || null) : req.user.memberId;
  const { rows } = await query(
    `${LOAN_SELECT} WHERE ($1::text IS NULL OR l.status = $1) AND ($2::uuid IS NULL OR l.member_id = $2)
     ORDER BY l.applied_at DESC LIMIT 500`,
    [status, memberId]);
  res.json(rows.map(shapeLoan));
}));

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

// Eligibility check, shown to the applicant before submitting.
router.get('/eligibility/:memberId', wrap(async (req, res) => {
  if (!isStaff(req.user) && req.user.memberId !== req.params.memberId) throw httpError(403, 'Not allowed');
  const s = await getSettings();
  const base = await savingsAndShares({ query }, req.params.memberId);
  res.json({
    savingsAndShares: base,
    maxLoan: maxLoanAmount({ savingsAndSharesToea: base, multiple: s.loan_max_multiple, cap: s.loan_max_amount_toea }),
    maxTermMonths: s.loan_max_term_months,
    annualRatePct: s.loan_interest_rate_pct,
    requireGuarantor: s.require_guarantor,
  });
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

  const s = await getSettings();
  if (termMonths > s.loan_max_term_months) throw httpError(400, `Maximum term is ${s.loan_max_term_months} months`);

  const base = await savingsAndShares({ query }, memberId);
  const max = maxLoanAmount({ savingsAndSharesToea: base, multiple: s.loan_max_multiple, cap: s.loan_max_amount_toea });
  if (principal > max) throw httpError(400, 'Amount exceeds the maximum loan for this member');

  if (s.require_guarantor) {
    if (!b.guarantorId || b.guarantorId === memberId) throw httpError(400, 'A guarantor is required');
    const g = await savingsAndShares({ query }, b.guarantorId);
    if (g < s.guarantor_min_savings_toea) throw httpError(400, 'Guarantor does not meet the minimum savings requirement');
  }

  const { rows } = await withTransaction(async (c) => {
    const r = await c.query(
      `INSERT INTO loans (loan_no, member_id, guarantor_id, principal_toea, annual_rate_pct, term_months, method, purpose)
       VALUES ('L' || nextval('loan_no_seq'), $1, $2, $3, $4, $5, $6, $7) RETURNING id, loan_no`,
      [memberId, b.guarantorId || null, principal, s.loan_interest_rate_pct, termMonths, s.loan_method,
       b.purpose ? String(b.purpose).slice(0, 500) : null]);
    await audit(req.user, 'loan.apply', 'loan', r.rows[0].id, { principal, termMonths }, c);
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
  if (!isStaff(req.user) && loan.member_id !== req.user.memberId) throw httpError(403, 'Not your loan');

  const inst = await query('SELECT * FROM loan_installments WHERE loan_id = $1 ORDER BY period', [loan.id]);
  const rep = await query('SELECT id, amount_toea, paid_on FROM loan_repayments WHERE loan_id = $1 ORDER BY paid_on, created_at', [loan.id]);
  const installments = inst.rows.map((i) => ({
    period: i.period, dueDate: i.due_date,
    principalDue: Number(i.principal_due), interestDue: Number(i.interest_due),
    principalPaid: Number(i.principal_paid), interestPaid: Number(i.interest_paid),
  }));
  res.json({
    ...shapeLoan(loan),
    installments,
    repayments: rep.rows.map((r) => ({ id: r.id, amount: Number(r.amount_toea), paidOn: r.paid_on })),
    outstanding: outstandingBalance(inst.rows),
    arrears: arrearsOf(inst.rows, isoDate()).length,
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

// Disbursement creates the repayment schedule. First instalment falls due one month after disbursement.
router.post('/:id/disburse', requireRole('admin'), wrap(async (req, res) => {
  const disbursedOn = isoDate(req.body?.disbursedOn);
  await withTransaction(async (c) => {
    const l = await c.query('SELECT * FROM loans WHERE id = $1 FOR UPDATE', [req.params.id]);
    const loan = l.rows[0];
    if (!loan) throw httpError(404, 'Loan not found');
    if (loan.status !== 'approved') throw httpError(400, 'Only approved loans can be disbursed');

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
  const result = await withTransaction(async (c) => {
    const l = await c.query('SELECT id, status FROM loans WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!l.rows[0]) throw httpError(404, 'Loan not found');
    if (l.rows[0].status !== 'disbursed') throw httpError(400, 'Loan is not active');

    const inst = await c.query('SELECT * FROM loan_installments WHERE loan_id = $1 ORDER BY period FOR UPDATE', [req.params.id]);
    const { updates, applied, excess } = allocateRepayment(inst.rows, amount);
    if (excess > 0) throw httpError(400, 'Repayment is more than the outstanding balance');

    for (const u of updates) {
      await c.query('UPDATE loan_installments SET principal_paid=$2, interest_paid=$3 WHERE id=$1',
        [u.id, u.principal_paid, u.interest_paid]);
    }
    await c.query('INSERT INTO loan_repayments (loan_id, amount_toea, paid_on, created_by) VALUES ($1,$2,$3,$4)',
      [req.params.id, applied, paidOn, req.user.sub]);

    const remaining = outstandingBalance(inst.rows.map((i) => {
      const u = updates.find((x) => x.id === i.id);
      return u ? { ...i, principal_paid: u.principal_paid, interest_paid: u.interest_paid } : i;
    }));
    if (remaining === 0) await c.query(`UPDATE loans SET status='closed' WHERE id=$1`, [req.params.id]);
    await audit(req.user, 'loan.repayment', 'loan', req.params.id, { amount: applied, paidOn }, c);
    return { applied, outstanding: remaining, closed: remaining === 0 };
  });
  await emailMemberAboutLoan(req.params.id, {
    kind: 'repayment', principal: result.applied, outstanding: result.outstanding,
    paidOn: paidOn,
  });
  res.status(201).json(result);
}));

export default router;
