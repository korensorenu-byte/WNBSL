import { query } from '../db/index.js';
import { sendMail } from './mailer.js';

/**
 * Send an email and record the attempt. Never throws: a failed email must not undo
 * a loan approval or a payment, so failures are logged and shown to staff instead.
 */
export async function notify({ to, subject, html, text }) {
  if (!to) return { status: 'skipped' };
  let result;
  try {
    result = await sendMail({ to, subject, html, text });
  } catch (err) {
    result = { status: 'failed', error: err.message };
  }
  await query(
    'INSERT INTO notifications (to_email, subject, status, error) VALUES ($1, $2, $3, $4)',
    [to, subject, result.status, result.error || null],
  ).catch((e) => console.error('[notify] could not record notification:', e.message));
  return result;
}

export const appUrl = () => (process.env.APP_URL || 'http://localhost:5173').replace(/\/$/, '');
