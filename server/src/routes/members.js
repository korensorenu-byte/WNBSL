import { Router } from 'express';
import { query, withTransaction } from '../db/index.js';
import { authenticate, requireRole, httpError } from '../middleware/auth.js';
import { wrap, audit, toeaFromRequest, isStaff, isoDate } from '../lib/http.js';

const router = Router();
router.use(authenticate);

// Share balance and total savings per member, used on list and detail views.
const MEMBER_SELECT = `
  SELECT m.*,
    COALESCE((SELECT SUM(CASE WHEN type='subscription' THEN amount_toea ELSE -amount_toea END)
              FROM share_transactions s WHERE s.member_id = m.id), 0)::bigint AS share_balance,
    COALESCE((SELECT SUM(CASE WHEN t.type='withdrawal' THEN -t.amount_toea ELSE t.amount_toea END)
              FROM savings_transactions t JOIN savings_accounts a ON a.id = t.account_id
              WHERE a.member_id = m.id), 0)::bigint AS savings_balance
  FROM members m`;

const shape = (r) => ({
  id: r.id,
  memberNo: r.member_no,
  fullName: r.full_name,
  phone: r.phone,
  email: r.email,
  address: r.address,
  village: r.village,
  idType: r.id_type,
  idNumber: r.id_number,
  joinedOn: r.joined_on,
  status: r.status,
  shareBalance: Number(r.share_balance),
  savingsBalance: Number(r.savings_balance),
});

router.get('/', requireRole('admin', 'officer', 'auditor'), wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const { rows } = await query(
    `${MEMBER_SELECT} WHERE ($1 = '' OR m.full_name ILIKE '%' || $1 || '%' OR m.member_no ILIKE '%' || $1 || '%')
     ORDER BY m.member_no LIMIT 500`,
    [q],
  );
  res.json(rows.map(shape));
}));

router.post('/', requireRole('admin', 'officer'), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.fullName || String(b.fullName).trim().length < 2) throw httpError(400, 'Full name is required');
  const { rows } = await withTransaction(async (c) => {
    const r = await c.query(
      `INSERT INTO members (member_no, full_name, phone, email, address, village, id_type, id_number, joined_on)
       VALUES ('M' || nextval('member_no_seq'), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [String(b.fullName).trim(), b.phone || null, b.email || null, b.address || null,
       b.village || null, b.idType || null, b.idNumber || null, isoDate(b.joinedOn)],
    );
    await audit(req.user, 'member.create', 'member', r.rows[0].id, { name: b.fullName }, c);
    return r;
  });
  res.status(201).json(shape({ ...rows[0], share_balance: 0, savings_balance: 0 }));
}));

router.get('/:id', wrap(async (req, res) => {
  if (!isStaff(req.user) && req.user.memberId !== req.params.id) throw httpError(403, 'You can only view your own record');
  const { rows } = await query(`${MEMBER_SELECT} WHERE m.id = $1`, [req.params.id]);
  if (!rows[0]) throw httpError(404, 'Member not found');
  res.json(shape(rows[0]));
}));

router.patch('/:id', requireRole('admin', 'officer'), wrap(async (req, res) => {
  const allowed = { full_name: 'fullName', phone: 'phone', email: 'email', address: 'address',
    village: 'village', status: 'status', id_type: 'idType', id_number: 'idNumber' };
  const sets = [];
  const vals = [];
  for (const [col, key] of Object.entries(allowed)) {
    if (key in (req.body || {})) {
      vals.push(req.body[key]);
      sets.push(`${col} = $${vals.length}`);
    }
  }
  if (!sets.length) throw httpError(400, 'Nothing to update');
  vals.push(req.params.id);
  const { rows } = await query(`UPDATE members SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING id`, vals);
  if (!rows[0]) throw httpError(404, 'Member not found');
  await audit(req.user, 'member.update', 'member', req.params.id, req.body);
  res.json({ ok: true });
}));

// Share capital: subscriptions and withdrawals.
router.post('/:id/shares', requireRole('admin', 'officer'), wrap(async (req, res) => {
  const amount = toeaFromRequest(req.body?.amount, 'Amount');
  const type = req.body?.type === 'withdrawal' ? 'withdrawal' : 'subscription';
  const result = await withTransaction(async (c) => {
    const m = await c.query('SELECT id, status FROM members WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!m.rows[0]) throw httpError(404, 'Member not found');
    if (m.rows[0].status !== 'active') throw httpError(400, 'Member is not active');
    if (type === 'withdrawal') {
      const bal = await c.query(
        `SELECT COALESCE(SUM(CASE WHEN type='subscription' THEN amount_toea ELSE -amount_toea END),0)::bigint AS b
         FROM share_transactions WHERE member_id = $1`, [req.params.id]);
      if (bal.rows[0].b < amount) throw httpError(400, 'Withdrawal exceeds share balance');
    }
    await c.query('INSERT INTO share_transactions (member_id, type, amount_toea, created_by) VALUES ($1,$2,$3,$4)',
      [req.params.id, type, amount, req.user.sub]);
    await audit(req.user, `shares.${type}`, 'member', req.params.id, { amount }, c);
    return true;
  });
  res.status(201).json({ ok: result });
}));

export default router;
