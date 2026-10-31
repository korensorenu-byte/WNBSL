// Shared loan money movements: funding by members, repayments and investor distributions.
// Every function takes a transaction client `c` so that all rows change together or not at all.
import { httpError } from '../middleware/auth.js';
import { audit, isoDate } from './http.js';
import { isHeldForMinor } from './people.js';
import { allocateRepayment, outstandingBalance } from './finance.js';

export async function fundedTotal(db, loanId) {
  const r = await db.query('SELECT COALESCE(SUM(amount_toea),0)::bigint AS t FROM loan_investments WHERE loan_id = $1', [loanId]);
  return Number(r.rows[0].t);
}

/** The member's oldest open savings account (where interest and returns are paid). */
export async function primaryAccountId(c, memberId) {
  const r = await c.query(
    `SELECT id FROM savings_accounts WHERE member_id = $1 AND status = 'open' ORDER BY opened_on, account_no LIMIT 1`,
    [memberId]);
  return r.rows[0]?.id || null;
}

/** Debit a savings account for a transfer out. Locks the row and refuses overdrawing. */
export async function debitSavings(c, { accountId, memberId, amount, reference, actor }) {
  const acc = await c.query(
    `SELECT a.id, a.status, a.member_id, a.guardian_member_id, m.date_of_birth
       FROM savings_accounts a JOIN members m ON m.id = a.member_id WHERE a.id = $1 FOR UPDATE OF a`, [accountId]);
  const a = acc.rows[0];
  if (!a || a.member_id !== memberId) throw httpError(404, 'Savings account not found');
  if (a.status !== 'open') throw httpError(400, 'Savings account is not open');
  if (isHeldForMinor(a, a.date_of_birth, isoDate())) {
    throw httpError(400, 'Money in a student investment account cannot be moved while the child is under 18');
  }
  const bal = await c.query(
    `SELECT COALESCE(SUM(CASE WHEN type='withdrawal' THEN -amount_toea ELSE amount_toea END),0)::bigint AS b
       FROM savings_transactions WHERE account_id = $1`, [accountId]);
  if (Number(bal.rows[0].b) < amount) throw httpError(400, 'Not enough money in this savings account');
  const tx = await c.query(
    `INSERT INTO savings_transactions (account_id, type, amount_toea, reference, created_by)
     VALUES ($1,'withdrawal',$2,$3,$4) RETURNING id`, [accountId, amount, reference, actor?.sub || null]);
  return tx.rows[0].id;
}

export { creditSavingsOrEarnings };

/** Add money to a member's savings (interest, returned capital). Falls back to earnings if no account. */
async function creditSavingsOrEarnings(c, { memberId, amount, type, reference, loanId, hold }) {
  const accountId = hold ? null : await primaryAccountId(c, memberId);
  if (accountId) {
    await c.query(
      `INSERT INTO savings_transactions (account_id, type, amount_toea, reference) VALUES ($1,$2,$3,$4)`,
      [accountId, type, amount, reference]);
    return 'savings';
  }
  await c.query(
    `INSERT INTO earnings_ledger (member_id, type, amount_toea, loan_id, note) VALUES ($1,'credit',$2,$3,$4)`,
    [memberId, amount, loanId, reference]);
  return 'earnings';
}

/**
 * Share a repayment's interest and principal between investors, pro-rata to their amount.
 * The last investor takes any rounding remainder, so every toea is accounted for.
 */
async function distributeToInvestors(c, { loanId, loanNo, principal, repaymentId, interest, principalReturned }) {
  if (interest === 0 && principalReturned === 0) return;
  const inv = await c.query(
    `SELECT li.id, li.member_id, li.amount_toea, m.interest_destination
       FROM loan_investments li JOIN members m ON m.id = li.member_id
      WHERE li.loan_id = $1 ORDER BY li.created_at, li.id`, [loanId]);

  let restInterest = interest;
  let restPrincipal = principalReturned;
  const n = inv.rows.length;
  for (let idx = 0; idx < n; idx++) {
    const row = inv.rows[idx];
    const last = idx === n - 1;
    const share = (total, rest) => (last ? rest : Math.floor((total * Number(row.amount_toea)) / principal));
    const i = share(interest, restInterest);
    const p = share(principalReturned, restPrincipal);
    restInterest -= i;
    restPrincipal -= p;

    await c.query(
      `INSERT INTO investment_distributions (loan_investment_id, repayment_id, interest_toea, principal_toea)
       VALUES ($1,$2,$3,$4)`, [row.id, repaymentId, i, p]);

    if (i > 0) {
      await creditSavingsOrEarnings(c, {
        memberId: row.member_id, amount: i, type: 'interest', loanId,
        reference: `Loan interest ${loanNo}`, hold: row.interest_destination === 'hold',
      });
    }
    if (p > 0) {
      await creditSavingsOrEarnings(c, {
        memberId: row.member_id, amount: p, type: 'deposit', loanId,
        reference: `Investment principal returned ${loanNo}`, hold: false,
      });
    }
  }
}

/**
 * Apply a repayment to a disbursed loan. source: 'cash' (paid at the cash desk),
 * 'savings' (moved from the borrower's savings) or 'earnings' (moved from held earnings).
 */
export async function applyRepayment(c, { loanId, amount, paidOn, actor, source = 'cash' }) {
  const l = await c.query('SELECT id, loan_no, status, principal_toea FROM loans WHERE id = $1 FOR UPDATE', [loanId]);
  const loan = l.rows[0];
  if (!loan) throw httpError(404, 'Loan not found');
  if (loan.status !== 'disbursed') throw httpError(400, 'Loan is not active');

  const inst = await c.query('SELECT * FROM loan_installments WHERE loan_id = $1 ORDER BY period FOR UPDATE', [loanId]);
  const before = new Map(inst.rows.map((r) => [r.id, r]));
  const { updates, applied, excess } = allocateRepayment(inst.rows, amount);
  if (excess > 0) throw httpError(400, 'Repayment is more than the outstanding balance');

  for (const u of updates) {
    await c.query('UPDATE loan_installments SET principal_paid=$2, interest_paid=$3 WHERE id=$1',
      [u.id, u.principal_paid, u.interest_paid]);
  }
  const rep = await c.query(
    `INSERT INTO loan_repayments (loan_id, amount_toea, paid_on, created_by, source)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`, [loanId, applied, paidOn, actor?.sub || null, source]);

  let interest = 0;
  let principalReturned = 0;
  for (const u of updates) {
    const old = before.get(u.id);
    interest += u.interest_paid - old.interest_paid;
    principalReturned += u.principal_paid - old.principal_paid;
  }

  const after = inst.rows.map((i) => {
    const u = updates.find((x) => x.id === i.id);
    return u ? { ...i, principal_paid: u.principal_paid, interest_paid: u.interest_paid } : i;
  });
  const remaining = outstandingBalance(after);
  if (remaining === 0) await c.query(`UPDATE loans SET status='closed' WHERE id=$1`, [loanId]);

  await distributeToInvestors(c, {
    loanId, loanNo: loan.loan_no, principal: Number(loan.principal_toea),
    repaymentId: rep.rows[0].id, interest, principalReturned,
  });
  await audit(actor, 'loan.repayment', 'loan', loanId, { amount: applied, source, interest, principalReturned }, c);
  return { repaymentId: rep.rows[0].id, applied, outstanding: remaining, closed: remaining === 0, loanNo: loan.loan_no };
}
