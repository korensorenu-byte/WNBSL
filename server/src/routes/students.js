// Student investment accounts: a parent opens and funds an account for a child under 18.
// The child owns the account at 18. Withdrawals before then only for approved medical needs.
import { Router } from 'express';
import { query, withTransaction } from '../db/index.js';
import { authenticate, requireRole, httpError } from '../middleware/auth.js';
import { wrap, audit, toeaFromRequest, isoDate } from '../lib/http.js';
import { ageOn, comingOfAgeDate, isHeldForMinor, COMING_OF_AGE } from '../lib/people.js';
import { debitSavings, primaryAccountId } from '../lib/loanOps.js';
import { inviteChildrenWhoTurned18 } from '../lib/jobs.js';
import { notify } from '../lib/notify.js';
import { society } from '../lib/templates.js';

const router = Router();
router.use(authenticate);

const kina = (t) => `K${(Number(t) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;

async function childAccounts(db, guardianId) {
  const r = await db.query(
    `SELECT a.id, a.account_no, a.status, a.guardian_member_id, a.member_id, a.opened_on,
            m.full_name AS child_name, m.date_of_birth, m.email AS child_email,
            (SELECT COALESCE(SUM(CASE WHEN type='withdrawal' THEN -amount_toea ELSE amount_toea END),0)::bigint
               FROM savings_transactions t WHERE t.account_id = a.id) AS balance
       FROM savings_accounts a JOIN members m ON m.id = a.member_id
      WHERE a.guardian_member_id = $1 AND a.product = 'Student Investment'
      ORDER BY m.full_name`, [guardianId]);
  const today = isoDate();
  return r.rows.map((a) => ({
    id: a.id, accountNo: a.account_no, status: a.status, childName: a.child_name,
    childAge: ageOn(a.date_of_birth, today), comingOfAge: comingOfAgeDate(a.date_of_birth),
    balance: Number(a.balance), held: isHeldForMinor(a, a.date_of_birth, today),
    childEmail: a.child_email,
  }));
}

// ---- Parent: open and view student accounts ----
router.get('/', requireRole('member'), wrap(async (req, res) => {
  const all = await childAccounts({ query }, req.user.memberId);
  res.json(all.filter((a) => a.held));
}));

router.post('/', requireRole('member'), wrap(async (req, res) => {
  const b = req.body || {};
  const childName = String(b.childName || '').trim();
  if (childName.length < 2) throw httpError(400, "Enter the child's full name");
  const dob = String(b.childDob || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) throw httpError(400, "Enter the child's date of birth");
  const age = ageOn(dob, isoDate());
  if (age < 0) throw httpError(400, 'Date of birth is in the future');
  if (age >= COMING_OF_AGE) throw httpError(400, 'The child is 18 or older. Ask them to join as a member instead.');
  const childEmail = b.childEmail ? String(b.childEmail).trim().toLowerCase() : null;
  const amount = b.initialAmount ? toeaFromRequest(b.initialAmount, 'Opening amount') : 0;
  const guardian = req.user.memberId;

  const result = await withTransaction(async (c) => {
    const child = await c.query(
      `INSERT INTO members (member_no, full_name, email, date_of_birth, guardian_member_id, relationship_to_head, sex)
       VALUES ('M' || nextval('member_no_seq'), $1, $2, $3, $4, 'child', $5) RETURNING id`,
      [childName, childEmail, dob, guardian, b.sex || null]);
    const acc = await c.query(
      `INSERT INTO savings_accounts (account_no, member_id, product, guardian_member_id)
       VALUES ('S' || nextval('account_no_seq'), $1, 'Student Investment', $2) RETURNING id, account_no`,
      [child.rows[0].id, guardian]);
    if (amount > 0) {
      const source = b.savingsAccountId || (await primaryAccountId(c, guardian));
      if (!source) throw httpError(400, 'You need a savings account to fund this from');
      await debitSavings(c, { accountId: source, memberId: guardian, amount, reference: `Student account ${acc.rows[0].account_no}`, actor: req.user });
      await c.query(
        `INSERT INTO savings_transactions (account_id, type, amount_toea, reference) VALUES ($1,'deposit',$2,'Opening deposit from parent')`,
        [acc.rows[0].id, amount]);
    }
    await audit(req.user, 'student_account.open', 'savings_account', acc.rows[0].id, { child: child.rows[0].id, amount }, c);
    return { accountId: acc.rows[0].id, accountNo: acc.rows[0].account_no };
  });
  res.status(201).json(result);
}));

// Same list as above, kept as an alias for the portal.
router.get('/mine', requireRole('member'), wrap(async (req, res) => {
  const all = await childAccounts({ query }, req.user.memberId);
  res.json(all.filter((a) => a.held));
}));

// Parent adds money to a child's account while the child is under 18.
router.post('/:id/deposit', requireRole('member'), wrap(async (req, res) => {
  const amount = toeaFromRequest(req.body?.amount, 'Amount');
  const guardian = req.user.memberId;
  const acc = await query('SELECT id, guardian_member_id FROM savings_accounts WHERE id = $1', [req.params.id]);
  if (!acc.rows[0] || acc.rows[0].guardian_member_id !== guardian) throw httpError(404, 'Account not found');
  const source = req.body?.savingsAccountId || (await primaryAccountId({ query }, guardian));
  await withTransaction(async (c) => {
    await debitSavings(c, { accountId: source, memberId: guardian, amount, reference: 'Top-up to student account', actor: req.user });
    await c.query(`INSERT INTO savings_transactions (account_id, type, amount_toea, reference) VALUES ($1,'deposit',$2,'Top-up from parent')`,
      [req.params.id, amount]);
  });
  res.status(201).json({ ok: true });
}));

// Parent asks for money for a medical need. Only an administrator can approve.
router.post('/:id/medical-requests', requireRole('member'), wrap(async (req, res) => {
  const amount = toeaFromRequest(req.body?.amount, 'Amount');
  const reason = String(req.body?.reason || '').trim();
  if (reason.length < 10) throw httpError(400, 'Describe the medical need (at least a sentence)');
  const acc = await query(
    `SELECT a.id, a.guardian_member_id, m.date_of_birth, a.status, a.member_id
       FROM savings_accounts a JOIN members m ON m.id = a.member_id WHERE a.id = $1`, [req.params.id]);
  const a = acc.rows[0];
  if (!a || a.guardian_member_id !== req.user.memberId) throw httpError(404, 'Account not found');
  if (!isHeldForMinor(a, a.date_of_birth, isoDate())) throw httpError(400, 'This account now belongs to the child');
  const r = await query(
    `INSERT INTO medical_withdrawal_requests (savings_account_id, guardian_member_id, amount_toea, reason, evidence_note)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [a.id, req.user.memberId, amount, reason.slice(0, 1000), req.body?.evidenceNote ? String(req.body.evidenceNote).slice(0, 500) : null]);
  await audit(req.user, 'medical_withdrawal.request', 'savings_account', a.id, { amount });
  res.status(201).json({ id: r.rows[0].id, status: 'pending' });
}));

// ---- Staff: review medical requests ----
router.get('/medical-requests', requireRole('admin', 'officer'), wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT r.*, a.account_no, c.full_name AS child_name, g.full_name AS guardian_name
       FROM medical_withdrawal_requests r
       JOIN savings_accounts a ON a.id = r.savings_account_id
       JOIN members c ON c.id = a.member_id
       JOIN members g ON g.id = r.guardian_member_id
      ORDER BY r.created_at DESC LIMIT 200`);
  res.json(rows.map((r) => ({
    id: r.id, accountNo: r.account_no, childName: r.child_name, guardianName: r.guardian_name,
    amount: Number(r.amount_toea), reason: r.reason, evidenceNote: r.evidence_note, status: r.status,
    decisionNote: r.decision_note, createdAt: r.created_at,
  })));
}));

router.post('/medical-requests/:rid/approve', requireRole('admin'), wrap(async (req, res) => {
  const note = req.body?.note ? String(req.body.note).slice(0, 500) : null;
  const result = await withTransaction(async (c) => {
    const r = await c.query(`SELECT * FROM medical_withdrawal_requests WHERE id = $1 AND status = 'pending' FOR UPDATE`, [req.params.rid]);
    const reqRow = r.rows[0];
    if (!reqRow) throw httpError(400, 'Only pending requests can be approved');
    const acc = await c.query(
      `SELECT a.id, a.guardian_member_id, m.date_of_birth FROM savings_accounts a JOIN members m ON m.id = a.member_id
        WHERE a.id = $1 FOR UPDATE OF a`, [reqRow.savings_account_id]);
    const a = acc.rows[0];
    if (!isHeldForMinor(a, a.date_of_birth, isoDate())) throw httpError(400, 'The child is now 18; the account belongs to the child');
    const bal = await c.query(
      `SELECT COALESCE(SUM(CASE WHEN type='withdrawal' THEN -amount_toea ELSE amount_toea END),0)::bigint AS b
         FROM savings_transactions WHERE account_id = $1`, [a.id]);
    if (Number(bal.rows[0].b) < Number(reqRow.amount_toea)) throw httpError(400, 'Not enough money in the student account');

    // Money leaves the child's account and is credited to the parent's savings, so it can be traced.
    await c.query(
      `INSERT INTO savings_transactions (account_id, type, amount_toea, reference, created_by)
       VALUES ($1,'withdrawal',$2,'Medical withdrawal (approved)',$3)`, [a.id, reqRow.amount_toea, req.user.sub]);
    const parentAccount = await primaryAccountId(c, reqRow.guardian_member_id);
    if (parentAccount) {
      await c.query(
        `INSERT INTO savings_transactions (account_id, type, amount_toea, reference, created_by)
         VALUES ($1,'deposit',$2,'Medical withdrawal from child account',$3)`, [parentAccount, reqRow.amount_toea, req.user.sub]);
    }
    await c.query(
      `UPDATE medical_withdrawal_requests SET status='approved', decision_note=$2, decided_by=$3, decided_at=now() WHERE id=$1`,
      [reqRow.id, note, req.user.sub]);
    await audit(req.user, 'medical_withdrawal.approve', 'savings_account', a.id, { amount: Number(reqRow.amount_toea) }, c);
    return { guardianId: reqRow.guardian_member_id, amount: Number(reqRow.amount_toea) };
  });
  const g = await query('SELECT full_name, email FROM members WHERE id = $1', [result.guardianId]);
  if (g.rows[0]?.email) {
    await notify({
      to: g.rows[0].email,
      subject: 'Medical withdrawal approved',
      html: `<p>Dear ${g.rows[0].full_name},</p><p>Your medical withdrawal of <b>${kina(result.amount)}</b> from the student account has been approved and recorded.</p><p>${society()}</p>`,
      text: `Dear ${g.rows[0].full_name},\n\nYour medical withdrawal of ${kina(result.amount)} from the student account has been approved and recorded.\n\n${society()}`,
    });
  }
  res.json({ ok: true });
}));

router.post('/medical-requests/:rid/decline', requireRole('admin'), wrap(async (req, res) => {
  const note = String(req.body?.note || '').slice(0, 500) || null;
  const { rows } = await query(
    `UPDATE medical_withdrawal_requests SET status='declined', decision_note=$2, decided_by=$3, decided_at=now()
      WHERE id=$1 AND status='pending' RETURNING guardian_member_id`, [req.params.rid, note, req.user.sub]);
  if (!rows[0]) throw httpError(400, 'Only pending requests can be declined');
  await audit(req.user, 'medical_withdrawal.decline', 'medical_request', req.params.rid, { note });
  res.json({ ok: true });
}));

// Administrator: invite children who have turned 18 now (the scheduler also does this).
router.post('/coming-of-age', requireRole('admin'), wrap(async (req, res) => {
  res.json(await inviteChildrenWhoTurned18({ actor: req.user.sub }));
}));

export default router;
