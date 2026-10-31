// Member self-service portal. Every query is scoped to the signed-in member's own records.
import { Router } from 'express';
import { query, withTransaction } from '../db/index.js';
import { authenticate, requireRole, httpError } from '../middleware/auth.js';
import { wrap, audit, toeaFromRequest, isoDate } from '../lib/http.js';
import { outstandingBalance } from '../lib/finance.js';
import { applyRepayment, debitSavings } from '../lib/loanOps.js';
import { notify } from '../lib/notify.js';
import { society } from '../lib/templates.js';

const router = Router();
router.use(authenticate, requireRole('member'));

const kina = (t) => `K${(Number(t) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function earningsBalance(db, memberId) {
  const r = await db.query(
    `SELECT COALESCE(SUM(CASE WHEN type='credit' THEN amount_toea ELSE -amount_toea END),0)::bigint AS b
       FROM earnings_ledger WHERE member_id = $1`, [memberId]);
  return Number(r.rows[0].b);
}

async function memberRow(db, memberId) {
  const r = await db.query('SELECT id, full_name, email, interest_destination FROM members WHERE id = $1', [memberId]);
  if (!r.rows[0]) throw httpError(404, 'Member not found');
  return r.rows[0];
}

// Everything a member needs to monitor their money on one screen.
router.get('/summary', wrap(async (req, res) => {
  const memberId = req.user.memberId;
  const m = await memberRow({ query }, memberId);

  const shares = await query(
    `SELECT COALESCE(SUM(CASE WHEN type='subscription' THEN amount_toea ELSE -amount_toea END),0)::bigint AS b
       FROM share_transactions WHERE member_id = $1`, [memberId]);
  const accounts = await query(
    `SELECT a.id, a.account_no, a.product, a.status,
            (SELECT COALESCE(SUM(CASE WHEN type='withdrawal' THEN -amount_toea ELSE amount_toea END),0)::bigint
               FROM savings_transactions t WHERE t.account_id = a.id) AS balance
       FROM savings_accounts a WHERE a.member_id = $1 ORDER BY a.account_no`, [memberId]);

  const loans = await query(
    `SELECT l.id, l.loan_no, l.status, l.principal_toea, l.annual_rate_pct, l.term_months, p.name AS product_name,
            (SELECT COALESCE(SUM(li.amount_toea),0)::bigint FROM loan_investments li WHERE li.loan_id = l.id) AS funded
       FROM loans l LEFT JOIN loan_products p ON p.id = l.product_id
      WHERE l.member_id = $1 ORDER BY l.applied_at DESC`, [memberId]);
  const loanOut = [];
  for (const l of loans.rows) {
    let outstanding = 0;
    let nextDue = null;
    let overdue = 0;
    if (l.status === 'disbursed') {
      const inst = await query('SELECT * FROM loan_installments WHERE loan_id = $1 ORDER BY period', [l.id]);
      outstanding = outstandingBalance(inst.rows);
      const today = isoDate();
      const open = inst.rows.find((i) => i.principal_paid + i.interest_paid < i.principal_due + i.interest_due);
      if (open) nextDue = { dueDate: open.due_date, amount: Number(open.principal_due + open.interest_due - open.principal_paid - open.interest_paid) };
      overdue = inst.rows
        .filter((i) => i.due_date < today && i.principal_paid + i.interest_paid < i.principal_due + i.interest_due)
        .reduce((s, i) => s + Number(i.principal_due + i.interest_due - i.principal_paid - i.interest_paid), 0);
    }
    loanOut.push({
      id: l.id, loanNo: l.loan_no, status: l.status, productName: l.product_name,
      principal: Number(l.principal_toea), funded: Number(l.funded), annualRatePct: Number(l.annual_rate_pct),
      termMonths: l.term_months, outstanding, nextDue, overdue,
    });
  }

  const invest = await query(
    `SELECT li.id, li.amount_toea, li.created_at, l.loan_no, l.status, l.principal_toea, p.name AS product_name,
            COALESCE((SELECT SUM(d.interest_toea) FROM investment_distributions d WHERE d.loan_investment_id = li.id),0)::bigint AS interest,
            COALESCE((SELECT SUM(d.principal_toea) FROM investment_distributions d WHERE d.loan_investment_id = li.id),0)::bigint AS returned
       FROM loan_investments li JOIN loans l ON l.id = li.loan_id LEFT JOIN loan_products p ON p.id = l.product_id
      WHERE li.member_id = $1 ORDER BY li.created_at DESC`, [memberId]);
  const investments = invest.rows.map((r) => ({
    id: r.id, loanNo: r.loan_no, productName: r.product_name, amount: Number(r.amount_toea),
    returned: Number(r.returned), interestEarned: Number(r.interest),
    stillInvested: Math.max(0, Number(r.amount_toea) - Number(r.returned)),
    loanStatus: r.status,
    stage: r.status === 'approved' ? 'Waiting for funding' : r.status === 'disbursed' ? 'Earning' : r.status === 'closed' ? 'Repaid' : r.status,
    investedOn: r.created_at,
  }));

  const activity = await query(
    `(SELECT t.created_at AS at, 'Savings '||t.type AS kind, t.amount_toea AS amount,
             CASE WHEN t.type='withdrawal' THEN -1 ELSE 1 END AS sign, COALESCE(t.reference,'') AS note
        FROM savings_transactions t JOIN savings_accounts a ON a.id = t.account_id WHERE a.member_id = $1
       ORDER BY t.created_at DESC LIMIT 20)
     UNION ALL
     (SELECT e.created_at AS at, 'Earnings '||e.type AS kind, e.amount_toea AS amount,
             CASE WHEN e.type='debit' THEN -1 ELSE 1 END AS sign, COALESCE(e.note,'') AS note
        FROM earnings_ledger e WHERE e.member_id = $1 ORDER BY e.created_at DESC LIMIT 20)
     ORDER BY at DESC LIMIT 25`, [memberId]);

  res.json({
    member: { id: m.id, fullName: m.full_name, interestDestination: m.interest_destination },
    shareCapital: Number(shares.rows[0].b),
    savingsTotal: accounts.rows.reduce((s, a) => s + Number(a.balance), 0),
    accounts: accounts.rows.map((a) => ({ id: a.id, accountNo: a.account_no, product: a.product, status: a.status, balance: Number(a.balance) })),
    earningsBalance: await earningsBalance({ query }, memberId),
    loans: loanOut,
    investments,
    recentActivity: activity.rows.map((a) => ({ at: a.at, kind: a.kind, amount: Number(a.amount) * Number(a.sign), note: a.note })),
  });
}));

// Repay a loan from savings or from held earnings.
router.post('/loans/:id/repay', wrap(async (req, res) => {
  const memberId = req.user.memberId;
  const amount = toeaFromRequest(req.body?.amount, 'Amount');
  const source = req.body?.source === 'earnings' ? 'earnings' : 'savings';
  const accountId = req.body?.accountId;
  if (source === 'savings' && !accountId) throw httpError(400, 'Choose the savings account to pay from');

  const loan = await query('SELECT id, loan_no, member_id, status FROM loans WHERE id = $1', [req.params.id]);
  const l = loan.rows[0];
  if (!l || l.member_id !== memberId) throw httpError(404, 'Loan not found');
  if (l.status !== 'disbursed') throw httpError(400, 'This loan is not active');

  const result = await withTransaction(async (c) => {
    if (source === 'savings') {
      await debitSavings(c, { accountId, memberId, amount, reference: `Loan repayment ${l.loan_no}`, actor: req.user });
    } else {
      const bal = await earningsBalance(c, memberId);
      if (bal < amount) throw httpError(400, 'Not enough held earnings for this payment');
      await c.query(
        `INSERT INTO earnings_ledger (member_id, type, amount_toea, loan_id, note) VALUES ($1,'debit',$2,$3,$4)`,
        [memberId, amount, l.id, `Loan repayment ${l.loan_no}`]);
    }
    return applyRepayment(c, { loanId: l.id, amount, paidOn: isoDate(), actor: req.user, source });
  });

  const m = await memberRow({ query }, memberId);
  if (m.email) {
    await notify({
      to: m.email,
      subject: `Repayment received on loan ${l.loan_no}`,
      html: `<p>Dear ${m.full_name},</p><p>We received your repayment of <b>${kina(result.applied)}</b> for loan ${l.loan_no}. Outstanding balance: <b>${kina(result.outstanding)}</b>.</p><p>${society()}</p>`,
      text: `Dear ${m.full_name},\n\nWe received your repayment of ${kina(result.applied)} for loan ${l.loan_no}. Outstanding balance: ${kina(result.outstanding)}.\n\n${society()}`,
    });
  }
  res.status(201).json({ applied: result.applied, outstanding: result.outstanding, closed: result.closed });
}));

// Move held earnings to savings, or use them to repay a loan.
router.post('/earnings/transfer', wrap(async (req, res) => {
  const memberId = req.user.memberId;
  const amount = toeaFromRequest(req.body?.amount, 'Amount');
  const to = req.body?.to === 'loan' ? 'loan' : 'savings';

  const result = await withTransaction(async (c) => {
    const bal = await earningsBalance(c, memberId);
    if (bal < amount) throw httpError(400, 'Not enough held earnings for this transfer');

    if (to === 'savings') {
      const accountId = req.body?.accountId;
      const acc = await c.query(
        `SELECT id FROM savings_accounts WHERE id = $1 AND member_id = $2 AND status = 'open'`, [accountId, memberId]);
      if (!acc.rows[0]) throw httpError(400, 'Choose one of your open savings accounts');
      await c.query(
        `INSERT INTO savings_transactions (account_id, type, amount_toea, reference) VALUES ($1,'deposit',$2,'Transfer from earnings')`,
        [accountId, amount]);
      await c.query(
        `INSERT INTO earnings_ledger (member_id, type, amount_toea, note) VALUES ($1,'debit',$2,'Transferred to savings')`,
        [memberId, amount]);
      await audit(req.user, 'earnings.to_savings', 'member', memberId, { amount }, c);
      return { to, amount };
    }

    const loanId = req.body?.loanId;
    const loan = await c.query(`SELECT loan_no FROM loans WHERE id = $1 AND member_id = $2`, [loanId, memberId]);
    if (!loan.rows[0]) throw httpError(404, 'Loan not found');
    await c.query(
      `INSERT INTO earnings_ledger (member_id, type, amount_toea, loan_id, note) VALUES ($1,'debit',$2,$3,$4)`,
      [memberId, amount, loanId, `Loan repayment ${loan.rows[0].loan_no}`]);
    const rep = await applyRepayment(c, { loanId, amount, paidOn: isoDate(), actor: req.user, source: 'earnings' });
    return { to, amount, outstanding: rep.outstanding, closed: rep.closed };
  });
  res.status(201).json(result);
}));

// Choose where future loan interest goes: 'savings' (automatic) or 'hold' (kept as earnings).
router.patch('/preferences', wrap(async (req, res) => {
  const dest = req.body?.interestDestination;
  if (!['savings', 'hold'].includes(dest)) throw httpError(400, 'interestDestination must be savings or hold');
  await query('UPDATE members SET interest_destination = $2 WHERE id = $1', [req.user.memberId, dest]);
  await audit(req.user, 'preferences.interest', 'member', req.user.memberId, { dest });
  res.json({ ok: true, interestDestination: dest });
}));

export default router;
