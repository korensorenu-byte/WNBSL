import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { query, withTransaction } from '../db/index.js';
import { authenticate, requireRole, signToken, httpError } from '../middleware/auth.js';
import { wrap, audit } from '../lib/http.js';
import { createInvitation, findUsableInvitation, normaliseEmail, STAFF_ROLES } from '../lib/invitations.js';

const router = Router();

// ---- Public: the invitee opens the link and sets a password ----
router.get('/by-token/:token', wrap(async (req, res) => {
  const inv = await findUsableInvitation(req.params.token);
  res.json({
    email: inv.email,
    role: inv.role,
    fullName: inv.full_name || inv.member_name || '',
    memberName: inv.member_name || null,
    expiresAt: inv.expires_at,
  });
}));

router.post('/accept', wrap(async (req, res) => {
  const { token, password } = req.body || {};
  const inv = await findUsableInvitation(token);
  if (!password || String(password).length < 12) throw httpError(400, 'Password must be at least 12 characters');

  const fullName = String(inv.full_name || inv.member_name || req.body?.fullName || '').trim();
  if (fullName.length < 2) throw httpError(400, 'Please enter your full name');

  const hash = await bcrypt.hash(String(password), 12);
  const user = await withTransaction(async (c) => {
    const claimed = await c.query(
      'UPDATE invitations SET accepted_at = now() WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id',
      [inv.id]);
    if (!claimed.rowCount) throw httpError(410, 'This invitation has already been used.');
    const u = await c.query(
      `INSERT INTO users (email, full_name, password_hash, role, member_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, email, full_name, role, member_id`,
      [inv.email, fullName, hash, inv.role, inv.member_id]);
    await audit({ sub: u.rows[0].id }, 'invitation.accepted', 'user', u.rows[0].id, { role: inv.role }, c);
    return u.rows[0];
  }).catch((err) => {
    if (err.code === '23505') throw httpError(409, 'An account with this email already exists. Please sign in.');
    throw err;
  });

  res.status(201).json({
    token: signToken(user),
    user: { id: user.id, email: user.email, fullName: user.full_name, role: user.role, memberId: user.member_id },
  });
}));

// ---- Staff: manage invitations ----
router.use(authenticate);

router.get('/', requireRole('admin', 'officer'), wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT i.id, i.email, i.role, i.full_name, i.expires_at, i.accepted_at, i.revoked_at, i.created_at, m.full_name AS member_name
       FROM invitations i LEFT JOIN members m ON m.id = i.member_id
      ORDER BY i.created_at DESC LIMIT 300`);
  res.json(rows.map((r) => ({
    id: r.id, email: r.email, role: r.role, fullName: r.full_name || r.member_name, memberName: r.member_name,
    expiresAt: r.expires_at, createdAt: r.created_at,
    status: r.accepted_at ? 'accepted' : r.revoked_at ? 'cancelled' : new Date(r.expires_at) < new Date() ? 'expired' : 'pending',
  })));
}));

router.post('/', requireRole('admin', 'officer'), wrap(async (req, res) => {
  const { email, role, fullName, memberId } = req.body || {};
  // Only administrators can invite staff. Loan officers can invite members to their portal.
  if (STAFF_ROLES.includes(role) && req.user.role !== 'admin') {
    throw httpError(403, 'Only administrators can invite staff');
  }
  const result = await createInvitation({
    email: normaliseEmail(email), role, fullName: fullName ? String(fullName).trim() : null,
    memberId: memberId || null, invitedBy: req.user.sub,
  });
  await audit(req.user, 'invitation.create', 'invitation', result.id, { role, email: normaliseEmail(email) });
  res.status(201).json(result);
}));

router.post('/:id/revoke', requireRole('admin'), wrap(async (req, res) => {
  const { rows } = await query(
    `UPDATE invitations SET revoked_at = now() WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING id`,
    [req.params.id]);
  if (!rows[0]) throw httpError(400, 'Only pending invitations can be cancelled');
  await audit(req.user, 'invitation.revoke', 'invitation', req.params.id);
  res.json({ ok: true });
}));

router.post('/:id/resend', requireRole('admin', 'officer'), wrap(async (req, res) => {
  const { rows } = await query('SELECT * FROM invitations WHERE id = $1 AND accepted_at IS NULL', [req.params.id]);
  const old = rows[0];
  if (!old) throw httpError(400, 'Only pending invitations can be resent');
  if (STAFF_ROLES.includes(old.role) && req.user.role !== 'admin') throw httpError(403, 'Only administrators can resend staff invitations');
  const result = await createInvitation({
    email: old.email, role: old.role, fullName: old.full_name, memberId: old.member_id, invitedBy: req.user.sub,
  });
  await audit(req.user, 'invitation.resend', 'invitation', result.id, { email: old.email });
  res.json(result);
}));

export default router;
