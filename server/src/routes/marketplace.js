import { Router } from 'express';
import { query, withTransaction } from '../db/index.js';
import { authenticate, requireRole, httpError } from '../middleware/auth.js';
import { wrap, audit, toeaFromRequest } from '../lib/http.js';
import { loanSchedule } from '../lib/finance.js';
import { debitSavings, fundedTotal } from '../lib/loanOps.js';
import { notify } from '../lib/notify.js';
import { society } from '../lib/templates.js';

const router = Router();
router.use(authenticate);

// Approved loans that are still open for member funding. Borrowers are anonymised: only the
// village is shown, so members compare terms without seeing who is borrowing.
router.get('/loans', wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT l.id, l.loan_no, l.member_id, l.principal_toea, l.annual_rate_pct, l.term_months, l.method, l.purpose,
            l.approved_at, p.name AS product_name, m.village,
            (SELECT COALESCE(SUM(li.amount_toea),0)::bigint FROM loan_investments li WHERE li.loan_id = l.id) AS funded
       FROM loans l
       JOIN members m ON m.id = l.member_id
       LEFT JOIN loan_products p ON p.id = l.product_id
      WHERE l.status = 'approved'
      ORDER BY l.approved_at NULLS LAST, l.loan_no`);

  res.json(rows.map((r) => {
    const principal = Number(r.principal_toea);
    const funded = Number(r.funded);
    const schedule = loanSchedule({
      principal, annualRatePct: Number(r.annual_rate_pct), termMonths: r.term_months, method: r.method,
    });
    const totalInterest = schedule.reduce((s, x) => s + x.interest, 0);
    return {
      id: r.id,
      loanNo: r.loan_no,
      productName: r.product_name,
      purpose: r.purpose,
      borrowerArea: r.village ? `Borrower from ${r.village}` : 'Borrower',
      principal,
      funded,
      remaining: principal - funded,
      percentFunded: principal ? Math.round((funded / principal) * 1000) / 10 : 0,
      annualRatePct: Number(r.annual_rate_pct),
      termMonths: r.term_months,
      method: r.method,
      firstMonthlyPayment: schedule[0]?.payment ?? 0,
      totalInterest,
      isOwnLoan: r.member_id === req.user.memberId,
    };
  }));
}));

// Member commits savings to a loan. The money leaves the savings account immediately.
router.post('/loans/:id/invest', requireRole('member'), wrap(async (req, res) => {
  const amount = toeaFromRequest(req.body?.amount, 'Amount');
  const savingsAccountId = req.body?.savingsAccountId;
  if (!savingsAccountId) throw httpError(400, 'Choose the savings account to invest from');
  const memberId = req.user.memberId;

  const result = await withTransaction(async (c) => {
    const l = await c.query('SELECT id, loan_no, member_id, status, principal_toea FROM loans WHERE id = $1 FOR UPDATE', [req.params.id]);
    const loan = l.rows[0];
    if (!loan) throw httpError(404, 'Loan not found');
    if (loan.status !== 'approved') throw httpError(400, 'This loan is not open for funding');
    if (loan.member_id === memberId) throw httpError(400, 'You cannot fund your own loan');

    const funded = await fundedTotal(c, loan.id);
    const remaining = Number(loan.principal_toea) - funded;
    if (amount > remaining) throw httpError(400, 'Amount is more than what is still needed for this loan');

    const txId = await debitSavings(c, {
      accountId: savingsAccountId, memberId, amount, reference: `Invest in ${loan.loan_no}`, actor: req.user,
    });
    const inv = await c.query(
      `INSERT INTO loan_investments (loan_id, member_id, amount_toea, savings_transaction_id)
       VALUES ($1,$2,$3,$4) RETURNING id`, [loan.id, memberId, amount, txId]);
    await audit(req.user, 'investment.fund_loan', 'loan', loan.id, { amount, investmentId: inv.rows[0].id }, c);
    return { investmentId: inv.rows[0].id, loanNo: loan.loan_no, funded: funded + amount, remaining: remaining - amount };
  });

  const m = await query('SELECT full_name, email FROM members WHERE id = $1', [memberId]);
  if (m.rows[0]?.email) {
    const kina = (t) => `K${(t / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    await notify({
      to: m.rows[0].email,
      subject: `You invested in loan ${result.loanNo}`,
      html: `<p>Dear ${m.rows[0].full_name},</p><p>You committed <b>${kina(amount)}</b> to loan ${result.loanNo}. Your share of repayments, interest and capital will be credited as the borrower repays.</p><p>${society()}</p>`,
      text: `Dear ${m.rows[0].full_name},\n\nYou committed ${kina(amount)} to loan ${result.loanNo}. Your share of repayments will be credited as the borrower repays.\n\n${society()}`,
    });
  }
  res.status(201).json(result);
}));

export default router;
