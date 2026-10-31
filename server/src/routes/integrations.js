// PNG LLG ward platform integration. The platform pushes households and their members
// over HTTPS with an API key. New people arrive as "pending_review" and staff approve them.
import { Router } from 'express';
import crypto from 'node:crypto';
import { query, withTransaction } from '../db/index.js';
import { authenticate, requireRole, httpError } from '../middleware/auth.js';
import { wrap, audit } from '../lib/http.js';
import { createInvitation, normaliseEmail } from '../lib/invitations.js';

const router = Router();
const hash = (k) => crypto.createHash('sha256').update(k).digest('hex');
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SEX = ['male', 'female', 'other'];
const MAX_MEMBERS = 50;

// ---- Ward platform: authenticate with X-Api-Key ----
const wardKey = wrap(async function wardKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key) return res.status(401).json({ error: 'Missing X-Api-Key header' });
  const r = await query('SELECT id FROM integration_keys WHERE key_hash = $1 AND active = TRUE', [hash(String(key))]);
  if (!r.rows[0]) return res.status(401).json({ error: 'Invalid or revoked API key' });
  await query('UPDATE integration_keys SET last_used_at = now() WHERE id = $1', [r.rows[0].id]);
  next();
});

const str = (v, max = 150) => (v == null || v === '' ? null : String(v).trim().slice(0, max));
const isoDob = (v) => {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw httpError(400, `Invalid date of birth: ${v}`);
  if (s > new Date().toISOString().slice(0, 10)) throw httpError(400, `Date of birth is in the future: ${v}`);
  return s;
};

/**
 * Body:
 * { externalRef, wardCode, village, head: { name, address },
 *   members: [{ externalRef, fullName, dateOfBirth, sex, relationshipToHead, phone, email, idNumber }] }
 * Repeating a push updates the same records (matched by externalRef), so the platform can resend safely.
 */
router.post('/ward/households', wardKey, wrap(async (req, res) => {
  const b = req.body || {};
  const householdRef = str(b.externalRef, 100);
  if (!householdRef) throw httpError(400, 'externalRef is required for the household');
  const people = Array.isArray(b.members) ? b.members : [];
  if (!people.length) throw httpError(400, 'At least one household member is required');
  if (people.length > MAX_MEMBERS) throw httpError(400, `Send at most ${MAX_MEMBERS} members per request`);

  const summary = { household: null, created: 0, updated: 0, errors: [] };
  await withTransaction(async (c) => {
    const h = await c.query(
      `INSERT INTO households (external_ref, ward_code, village, head_name, address, payload, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6, now())
       ON CONFLICT (external_ref) DO UPDATE SET ward_code = EXCLUDED.ward_code, village = EXCLUDED.village,
         head_name = EXCLUDED.head_name, address = EXCLUDED.address, payload = EXCLUDED.payload, updated_at = now()
       RETURNING id`,
      [householdRef, str(b.wardCode, 40), str(b.village, 120), str(b.head?.name), str(b.head?.address, 300), JSON.stringify(b)]);
    summary.household = h.rows[0].id;

    for (const p of people) {
      try {
        const ref = str(p.externalRef, 100);
        const name = str(p.fullName);
        if (!ref) throw new Error('externalRef is required');
        if (!name || name.length < 2) throw new Error('fullName is required');
        const sex = p.sex ? String(p.sex).toLowerCase() : null;
        if (sex && !SEX.includes(sex)) throw new Error(`sex must be one of ${SEX.join(', ')}`);
        const email = p.email ? normaliseEmail(p.email) : null;
        if (email && !EMAIL.test(email)) throw new Error('email is not valid');

        const existing = await c.query('SELECT id FROM members WHERE external_ref = $1', [ref]);
        if (existing.rows[0]) {
          await c.query(
            `UPDATE members SET full_name=$2, date_of_birth=$3, sex=$4, relationship_to_head=$5, phone=$6,
                    email=COALESCE($7, email), id_number=COALESCE($8, id_number), village=$9, address=$10,
                    household_id=$11, ward_code=$12, ward_payload=$13
              WHERE id = $1`,
            [existing.rows[0].id, name, isoDob(p.dateOfBirth), sex, str(p.relationshipToHead, 40), str(p.phone, 40),
             email, str(p.idNumber, 40), str(b.village, 120), str(b.head?.address, 300), h.rows[0].id,
             str(b.wardCode, 40), JSON.stringify(p)]);
          summary.updated += 1;
        } else {
          await c.query(
            `INSERT INTO members (member_no, full_name, date_of_birth, sex, relationship_to_head, phone, email,
                                  id_number, village, address, household_id, ward_code, external_ref, ward_payload, status)
             VALUES ('M' || nextval('member_no_seq'), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending_review')`,
            [name, isoDob(p.dateOfBirth), sex, str(p.relationshipToHead, 40), str(p.phone, 40), email,
             str(p.idNumber, 40), str(b.village, 120), str(b.head?.address, 300), h.rows[0].id,
             str(b.wardCode, 40), ref, JSON.stringify(p)]);
          summary.created += 1;
        }
      } catch (err) {
        summary.errors.push({ externalRef: p.externalRef || null, error: err.message });
      }
    }
    await audit(null, 'ward.push', 'household', h.rows[0].id, { created: summary.created, updated: summary.updated, errors: summary.errors.length }, c);
  });

  res.status(summary.errors.length && !summary.created && !summary.updated ? 422 : 202).json(summary);
}));

// ---- Staff: review arrivals from the ward platform ----
router.get('/ward/pending', authenticate, requireRole('admin', 'officer'), wrap(async (req, res) => {
  const { rows } = await query(
    `SELECT m.id, m.member_no, m.full_name, m.date_of_birth, m.sex, m.relationship_to_head, m.phone, m.email,
            m.village, m.ward_code, m.created_at, h.external_ref AS household_ref, h.head_name, h.address
       FROM members m LEFT JOIN households h ON h.id = m.household_id
      WHERE m.status = 'pending_review' ORDER BY h.external_ref NULLS LAST, m.full_name`);
  res.json(rows.map((r) => ({
    id: r.id, memberNo: r.member_no, fullName: r.full_name, dateOfBirth: r.date_of_birth, sex: r.sex,
    relationshipToHead: r.relationship_to_head, phone: r.phone, email: r.email, village: r.village,
    wardCode: r.ward_code, householdRef: r.household_ref, headName: r.head_name, address: r.address,
  })));
}));

router.post('/ward/members/:id/approve', authenticate, requireRole('admin', 'officer'), wrap(async (req, res) => {
  const { rows } = await query(
    `UPDATE members SET status = 'active' WHERE id = $1 AND status = 'pending_review' RETURNING id, full_name, email`,
    [req.params.id]);
  if (!rows[0]) throw httpError(400, 'Only people awaiting review can be approved');
  await audit(req.user, 'ward.approve', 'member', req.params.id);
  // Invite to the portal only when the person has an email and the caller asks for it.
  let invitation = null;
  if (req.body?.invite && rows[0].email) {
    invitation = await createInvitation({ email: rows[0].email, role: 'member', fullName: rows[0].full_name, memberId: rows[0].id, invitedBy: req.user.sub });
  }
  res.json({ ok: true, invitation });
}));

router.post('/ward/members/:id/reject', authenticate, requireRole('admin', 'officer'), wrap(async (req, res) => {
  const reason = str(req.body?.reason, 300) || 'Not confirmed by the ward';
  const { rows } = await query(
    `UPDATE members SET status = 'exited' WHERE id = $1 AND status = 'pending_review' RETURNING id`, [req.params.id]);
  if (!rows[0]) throw httpError(400, 'Only people awaiting review can be rejected');
  await audit(req.user, 'ward.reject', 'member', req.params.id, { reason });
  res.json({ ok: true });
}));

// ---- Administrator: manage API keys ----
router.get('/keys', authenticate, requireRole('admin'), wrap(async (req, res) => {
  const { rows } = await query('SELECT id, name, active, created_at, last_used_at FROM integration_keys ORDER BY created_at DESC');
  res.json(rows);
}));

router.post('/keys', authenticate, requireRole('admin'), wrap(async (req, res) => {
  const name = str(req.body?.name, 100);
  if (!name || name.length < 3) throw httpError(400, 'Give the key a name, for example "PNG LLG Ward Platform"');
  const key = `wnb_${crypto.randomBytes(24).toString('base64url')}`;
  const { rows } = await query('INSERT INTO integration_keys (name, key_hash) VALUES ($1,$2) RETURNING id', [name, hash(key)]);
  await audit(req.user, 'integration_key.create', 'integration_key', rows[0].id, { name });
  // Shown once. Only its hash is stored.
  res.status(201).json({ id: rows[0].id, name, key });
}));

router.post('/keys/:id/revoke', authenticate, requireRole('admin'), wrap(async (req, res) => {
  const { rows } = await query('UPDATE integration_keys SET active = FALSE WHERE id = $1 RETURNING id', [req.params.id]);
  if (!rows[0]) throw httpError(404, 'Key not found');
  await audit(req.user, 'integration_key.revoke', 'integration_key', req.params.id);
  res.json({ ok: true });
}));

export default router;
