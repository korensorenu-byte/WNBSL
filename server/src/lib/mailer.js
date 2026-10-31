// Sends email through Resend (https://resend.com). Without RESEND_API_KEY the message is
// printed to the console instead, so the full flow can be tested locally.
const API = 'https://api.resend.com/emails';

export async function sendMail({ to, subject, html, text }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM || 'WNBSLS <onboarding@resend.dev>';

  if (!key) {
    console.log(`[mail:dev] to=${to} subject="${subject}"\n${text}\n`);
    return { status: 'logged' };
  }

  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, html, text }),
  });
  if (!res.ok) {
    return { status: 'failed', error: `Resend ${res.status}: ${(await res.text()).slice(0, 300)}` };
  }
  return { status: 'sent' };
}
