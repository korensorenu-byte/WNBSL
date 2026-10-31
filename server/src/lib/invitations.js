import crypto from 'node:crypto';
import { query, withTransaction } from '../db/index.js';
import { httpError } from '../middleware/auth.js';
import { notify, appUrl } from './notify.js';
import { invitationEmail } from './templates.js';

export const INVITE_DAYS = 7;
export const ROLES = ['admin', 'officer', 'cashier', 'auditor', 'member'];
export const STAFF_ROLES = ['admin', 'officer', 'cashier', 'auditor'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const normaliseEmail = (e) => String(e || '').trim().toLowerCase();

/**
 * Create an invitation and email the link. Any earlier open invitation for the same
 * address is revoked. Returns the invitation id, expiry and email status. The link is
 * returned only when email is not configured (development), so it can still be tested.
 */
export async function createInvitation({ email, role, fullName, memberId, invitedBy }) {
  const addr = normaliseEmail(email);
  if (!EMAIL.test(addr)) throw httpError(400, 'A valid email address is required');
  if (!ROLES.includes(role)) throw httpError(400, 'Invalid role');
  if (role === 'member' && !memberId) throw httpError(400, 'Member invitations must be linked to a member');

  const existingUser = await query('SELECT 1 FROM users WHERE lower(email) = $1', [addr]);
  if (existingUser.rowCount) throw httpError(409, 'An account with this email already exists');
  if (memberId) {
    const m = await query('SELECT full_name FROM members WHERE id = $1', [memberId]);
    if (!m.rows[0]) throw httpError(404, 'Member not found');
    const linked = await query('SELECT 1 FROM users WHERE member_id = $1', [memberId]);
    if (linked.rowCount) throw httpError(409, 'This member already has a portal account');
  }

  const token = newToken();
  const expiresAt = new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000);
  const inv = await withTransaction(async (c) => {
    await c.query(
      `UPDATE invitations SET revoked_at = now()
        WHERE lower(email) = $1 AND accepted_at IS NULL AND revoked_at IS NULL`, [addr]);
    const r = await c.query(
      `INSERT INTO invitations (email, role, full_name, member_id, token_hash, expires_at, invited_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, expires_at`,
      [addr, role, fullName || null, memberId || null, hashToken(token), expiresAt, invitedBy || null]);
    return r.rows[0];
  });

  const link = `${appUrl()}/invite/${token}`;
  const member = memberId ? (await query('SELECT full_name FROM members WHERE id = $1', [memberId])).rows[0] : null;
  const mail = invitationEmail({ name: fullName, role, link, expiresAt: inv.expires_at, memberName: member?.full_name });
  const result = await notify({ to: addr, ...mail });

  return {
    id: inv.id,
    expiresAt: inv.expires_at,
    emailStatus: result.status,
    // Shown only when no email provider is configured, so local testing still works.
    devLink: result.status === 'logged' ? link : undefined,
  };
}

/** Look up a usable invitation from its raw token, or throw a clear error. */
export async function findUsableInvitation(token) {
  const { rows } = await query(
    `SELECT i.*, m.full_name AS member_name
       FROM invitations i LEFT JOIN members m ON m.id = i.member_id
      WHERE i.token_hash = $1`, [hashToken(String(token || ''))]);
  const inv = rows[0];
  if (!inv) throw httpError(404, 'This invitation link is not valid');
  if (inv.accepted_at) throw httpError(410, 'This invitation has already been used. Please sign in instead.');
  if (inv.revoked_at) throw httpError(410, 'This invitation was cancelled. Please ask the Society office for a new one.');
  if (new Date(inv.expires_at) < new Date()) throw httpError(410, 'This invitation has expired. Please ask for a new one.');
  return inv;
}
