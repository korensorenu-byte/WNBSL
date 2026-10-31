// Email wording. Every email has an HTML and a plain-text version.
export const society = () => process.env.SOCIETY_NAME || 'West New Britain Savings and Loans Society';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const ROLE_LABEL = {
  admin: 'Administrator',
  officer: 'Loan Officer',
  cashier: 'Cashier',
  auditor: 'Auditor',
  member: 'Member',
};
export const roleLabel = (r) => ROLE_LABEL[r] || r;

function layout(title, bodyHtml) {
  return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#1d2a25;background:#f4f6f5;padding:24px">
<div style="max-width:560px;margin:auto;background:#fff;border-radius:12px;padding:28px">
<h2 style="color:#0b4f3c;margin:0 0 4px">${esc(society())}</h2>
<h3 style="margin:12px 0">${esc(title)}</h3>
${bodyHtml}
<p style="color:#6b7a74;font-size:12px;margin-top:28px">This is an automated message. Please do not reply to it.</p>
</div></body></html>`;
}

const button = (href, label) =>
  `<p><a href="${esc(href)}" style="display:inline-block;background:#0b4f3c;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px">${esc(label)}</a></p>
<p style="font-size:12px;color:#6b7a74">If the button does not work, copy this link into your browser:<br>${esc(href)}</p>`;

export function invitationEmail({ name, role, link, expiresAt, memberName }) {
  const who = memberName ? `your member account (${memberName})` : `the ${roleLabel(role)} portal`;
  const expires = new Date(expiresAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const subject = `You are invited to the ${society()} system`;
  const html = layout(
    'You have been invited',
    `<p>Dear ${esc(name || 'Member')},</p>
<p>You have been invited to set up ${esc(who)}. Choose a password to activate your account.</p>
${button(link, 'Set up my account')}
<p>This link can be used once and expires on <b>${esc(expires)}</b>.</p>`,
  );
  const text = `Dear ${name || 'Member'},\n\nYou have been invited to set up ${who}.\nChoose a password here (valid once, until ${expires}):\n${link}\n\nIf you did not expect this email, you can ignore it.`;
  return { subject, html, text };
}

export function membershipReceivedEmail({ name }) {
  return {
    subject: `We received your membership request`,
    html: layout('Membership request received', `<p>Dear ${esc(name)},</p><p>Thank you for applying to join the Society. Our officers will review your request and contact you. You will receive an invitation to your member portal by email once it is approved.</p>`),
    text: `Dear ${name},\n\nThank you for applying to join the Society. We will review your request and email you once it is decided.`,
  };
}

export function membershipDecisionEmail({ name, approved, reason }) {
  if (approved) {
    return {
      subject: 'Your membership request was approved',
      html: layout('Membership approved', `<p>Dear ${esc(name)},</p><p>Your membership request has been approved. Please check your inbox for a separate invitation to set up your member portal account.</p>`),
      text: `Dear ${name},\n\nYour membership request has been approved. Check your inbox for an invitation to set up your portal account.`,
    };
  }
  return {
    subject: 'Update on your membership request',
    html: layout('Membership request', `<p>Dear ${esc(name)},</p><p>We are unable to approve your membership request at this time.</p>${reason ? `<p><b>Reason:</b> ${esc(reason)}</p>` : ''}<p>Please contact the Society office for more information.</p>`),
    text: `Dear ${name},\n\nWe are unable to approve your membership request at this time.${reason ? `\nReason: ${reason}` : ''}\nPlease contact the Society office for more information.`,
  };
}

export function adminNewRequestEmail({ name, phone, village, link }) {
  return {
    subject: `New membership request from ${name}`,
    html: layout('New membership request', `<p><b>${esc(name)}</b> has applied to join the Society.</p><p>Phone: ${esc(phone || '—')}<br>Village: ${esc(village || '—')}</p>${button(link, 'Review requests')}`),
    text: `${name} has applied to join the Society.\nPhone: ${phone || '—'}\nVillage: ${village || '—'}\nReview: ${link}`,
  };
}

export function loanUpdateEmail({ name, loanNo, status, principal, reason, outstanding, paidOn, kind }) {
  const kina = (toea) => `K${(Number(toea) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  if (kind === 'repayment') {
    return {
      subject: `Repayment received on loan ${loanNo}`,
      html: layout('Repayment received', `<p>Dear ${esc(name)},</p><p>We received your repayment of <b>${kina(principal)}</b> on ${esc(paidOn)} for loan ${esc(loanNo)}.</p><p>Outstanding balance: <b>${kina(outstanding)}</b></p>`),
      text: `Dear ${name},\n\nWe received your repayment of ${kina(principal)} on ${paidOn} for loan ${loanNo}.\nOutstanding balance: ${kina(outstanding)}`,
    };
  }
  const verb = { approved: 'approved', rejected: 'not approved', disbursed: 'disbursed' }[status] || status;
  return {
    subject: `Loan ${loanNo} ${verb}`,
    html: layout(`Loan ${verb}`, `<p>Dear ${esc(name)},</p><p>Your loan application <b>${esc(loanNo)}</b> for ${kina(principal)} has been <b>${esc(verb)}</b>.</p>${reason ? `<p>Reason: ${esc(reason)}</p>` : ''}`),
    text: `Dear ${name},\n\nYour loan application ${loanNo} for ${kina(principal)} has been ${verb}.${reason ? `\nReason: ${reason}` : ''}`,
  };
}
