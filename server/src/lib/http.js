import { httpError } from '../middleware/auth.js';
import { query } from '../db/index.js';

/** Wrap async route handlers so rejected promises reach the error handler. */
export const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/** Write an audit-trail row. Pass a transaction client when available. */
export async function audit(actor, action, entity, entityId, detail = null, db = { query }) {
  await db.query(
    'INSERT INTO audit_log (actor_id, action, entity, entity_id, detail) VALUES ($1, $2, $3, $4, $5)',
    [actor?.sub ?? null, action, entity, entityId ? String(entityId) : null, detail ? JSON.stringify(detail) : null],
  );
}

/** Ensure a value is a positive whole toea amount coming from the client (kina input is converted). */
export function toeaFromRequest(value, name) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw httpError(400, `${name} must be a positive amount in toea`);
  return n;
}

export function isoDate(value, fallback = new Date()) {
  if (!value) return fallback.toISOString().slice(0, 10);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw httpError(400, 'Invalid date');
  return d.toISOString().slice(0, 10);
}

/** Add whole months to a 'YYYY-MM-DD' date string, clamping to month end. */
export function addMonths(dateStr, months) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

export const isStaff = (user) => ['admin', 'officer', 'cashier', 'auditor'].includes(user.role);
