// Scheduled work: invite children on their 18th birthday, and pay out matured fixed deposits.
import { query, withTransaction } from '../db/index.js';
import { comingOfAgeDate } from './people.js';
import { createInvitation } from './invitations.js';
import { creditSavingsOrEarnings } from './loanOps.js';
import { isoDate, addMonths } from './http.js';

/** Invite each child who has reached 18 and has an email on file but no login yet. */
export async function inviteChildrenWhoTurned18({ actor = null } = {}) {
  const today = isoDate();
  const { rows } = await query(
    `SELECT m.id, m.full_name, m.email, m.date_of_birth
       FROM members m
      WHERE m.guardian_member_id IS NOT NULL AND m.date_of_birth IS NOT NULL
        AND m.email IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM users u WHERE u.member_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM invitations i WHERE i.member_id = m.id AND i.accepted_at IS NULL AND i.revoked_at IS NULL)`);
  const due = rows.filter((m) => comingOfAgeDate(m.date_of_birth) <= today);
  let invited = 0;
  for (const child of due) {
    try {
      await createInvitation({ email: child.email, role: 'member', fullName: child.full_name, memberId: child.id, invitedBy: actor });
      invited += 1;
    } catch (err) {
      console.error(`[jobs] could not invite child ${child.id}: ${err.message}`);
    }
  }
  return { checked: due.length, invited };
}

/** Pay matured fixed deposits: principal plus simple interest, credited to the source savings account. */
export async function payMaturedFixedDeposits() {
  const today = isoDate();
  const due = await query(
    `SELECT mi.id, mi.member_id, mi.savings_account_id, mi.principal_toea, mi.rate_pct, mi.start_on, mi.maturity_on
       FROM member_investments mi
      WHERE mi.status = 'active' AND mi.maturity_on IS NOT NULL AND mi.maturity_on <= $1`, [today]);
  let paid = 0;
  for (const mi of due.rows) {
    await withTransaction(async (c) => {
      const locked = await c.query(`SELECT status FROM member_investments WHERE id = $1 FOR UPDATE`, [mi.id]);
      if (locked.rows[0]?.status !== 'active') return;
      const principal = Number(mi.principal_toea);
      const days = (new Date(mi.maturity_on) - new Date(mi.start_on)) / 86400000;
      const interest = Math.round(principal * (Number(mi.rate_pct) / 100) * (days / 365));
      await c.query(
        `INSERT INTO savings_transactions (account_id, type, amount_toea, reference)
         VALUES ($1,'deposit',$2,'Fixed deposit matured')`, [mi.savings_account_id, principal + interest]);
      await c.query(
        `INSERT INTO member_investment_income (member_investment_id, amount_toea, kind) VALUES ($1,$2,'maturity')`,
        [mi.id, Math.max(interest, 1)]);
      await c.query(`UPDATE member_investments SET status='matured' WHERE id = $1`, [mi.id]);
      paid += 1;
    });
  }
  return { checked: due.rows.length, paid };
}

export async function runDailyJobs() {
  try {
    const kids = await inviteChildrenWhoTurned18();
    const fds = await payMaturedFixedDeposits();
    console.log(`[jobs] children invited: ${kids.invited}; fixed deposits paid: ${fds.paid}`);
  } catch (err) {
    console.error('[jobs] failed:', err.message);
  }
}

/** Run once at start-up and then every 6 hours. */
export function startScheduler() {
  runDailyJobs();
  setInterval(runDailyJobs, 6 * 60 * 60 * 1000).unref();
}
