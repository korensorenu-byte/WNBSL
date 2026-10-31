import { useEffect, useState } from 'react';
import { api, toKina, toToea, fmtDate } from './api.js';
import { useData, Action, Table, Field, Badge } from './pages.jsx';

export const ROLE_NAMES = { admin: 'Administrator', officer: 'Loan Officer', cashier: 'Cashier', auditor: 'Auditor', member: 'Member' };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Shows the link only when no email provider is configured (development).
function DevLink({ link }) {
  if (!link) return null;
  return (
    <div className="card small">
      Email is not configured on this server, so the invitation link is shown here instead:
      <div className="mono">{link}</div>
    </div>
  );
}

function emailNote(status) {
  if (status === 'sent') return 'Invitation email sent.';
  if (status === 'failed') return 'The email could not be sent. Check the notification log and resend.';
  if (status === 'logged') return 'Invitation created.';
  return '';
}

// ---------- Team: invite staff, manage invitations and accounts (administrator) ----------
export function TeamPage({ user }) {
  const { data: invites, error, reload } = useData('/invitations', []);
  const { data: users, reload: reloadUsers } = useData('/users', []);
  const [f, setF] = useState({ email: '', fullName: '', role: 'cashier' });
  const [result, setResult] = useState(null);
  const [formError, setFormError] = useState('');

  async function invite() {
    setFormError('');
    if (!EMAIL.test(f.email)) return setFormError('Enter a valid email address.');
    const r = await api('/invitations', { method: 'POST', body: { ...f, email: f.email.trim() } });
    setResult(r);
    setF({ email: '', fullName: '', role: f.role });
    reload();
  }

  return (
    <>
      <h2>Team and invitations</h2>
      <p className="muted small">Staff accounts are created only by invitation. The person receives an email with a one-time link to choose their password.</p>

      <div className="card form-grid">
        <Field label="Email"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label="Full name"><input value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></Field>
        <Field label="Role">
          <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            {['cashier', 'officer', 'auditor', 'admin'].map((r) => <option key={r} value={r}>{ROLE_NAMES[r]}</option>)}
          </select>
        </Field>
        <Action onRun={invite}>Send invitation</Action>
        {formError && <div className="error">{formError}</div>}
      </div>

      {result && (
        <div className="card">
          <div>{emailNote(result.emailStatus)}</div>
          <DevLink link={result.devLink} />
        </div>
      )}

      {error && <div className="error">{error}</div>}
      <h3>Invitations</h3>
      {invites && (
        <Table
          head={['Email', 'Role', 'Status', 'Expires', '']}
          rows={invites.map((i) => [
            i.email, ROLE_NAMES[i.role] || i.role, <Badge status={i.status} />, fmtDate(i.expiresAt),
            i.status === 'pending' ? (
              <span className="inline">
                <Action className="ghost" onRun={async () => { const r = await api(`/invitations/${i.id}/resend`, { method: 'POST' }); setResult(r); reload(); }}>Resend</Action>
                <Action className="ghost" onRun={async () => { await api(`/invitations/${i.id}/revoke`, { method: 'POST' }); reload(); }}>Cancel</Action>
              </span>
            ) : null,
          ])}
          empty="No invitations yet."
        />
      )}

      <h3>Accounts</h3>
      {users && (
        <Table
          head={['Name', 'Email', 'Role', 'Active', '']}
          rows={users.map((u) => [
            u.fullName, u.email, ROLE_NAMES[u.role] || u.role, u.active ? 'Yes' : 'No',
            u.id !== user.id ? (
              <Action className="ghost" onRun={async () => { await api(`/users/${u.id}`, { method: 'PATCH', body: { active: !u.active } }); reloadUsers(); }}>
                {u.active ? 'Deactivate' : 'Reactivate'}
              </Action>
            ) : <span className="muted small">You</span>,
          ])}
        />
      )}
    </>
  );
}

// ---------- Officer desk: membership queue, pending loans, overdue ----------
export function OfficerDeskPage({ user }) {
  const isAdmin = user.role === 'admin';
  const { data: requests, reload: reloadRequests } = useData('/membership-requests?status=pending', []);
  const { data: applied, reload: reloadApplied } = useData('/loans?status=applied', []);
  const { data: arrears } = useData('/loans/arrears', []);
  const [declineFor, setDeclineFor] = useState(null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState(null);

  const reloadAll = () => { reloadRequests(); reloadApplied(); };

  return (
    <>
      <h2>Officer desk</h2>
      <div className="stats">
        <div className="card stat"><div className="muted small">Membership requests</div><div className="stat-value">{requests?.length ?? '—'}</div></div>
        <div className="card stat"><div className="muted small">Loan applications waiting</div><div className="stat-value">{applied?.length ?? '—'}</div></div>
        <div className="card stat"><div className="muted small">Overdue instalments</div><div className="stat-value">{arrears?.length ?? '—'}</div></div>
      </div>

      {note && <div className="card small">{note}</div>}

      <h3>Membership requests</h3>
      {requests && (
        <Table
          head={['Applicant', 'Email', 'Phone', 'Village', 'Received', '']}
          rows={requests.map((r) => [
            r.fullName, r.email, r.phone || '—', r.village || '—', fmtDate(r.createdAt),
            <span className="inline">
              <Action onRun={async () => {
                const res = await api(`/membership-requests/${r.id}/approve`, { method: 'POST' });
                setNote(`Approved. Member record created and invitation ${res.invitation.emailStatus === 'sent' ? 'emailed' : 'created'}.`);
                reloadAll();
              }}>Approve and invite</Action>
              <button className="ghost" onClick={() => { setDeclineFor(r.id); setReason(''); }}>Decline</button>
            </span>,
          ])}
          empty="No pending requests."
        />
      )}
      {declineFor && (
        <div className="card form-row">
          <input placeholder="Reason (shown to the applicant)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Action className="danger" onRun={async () => {
            await api(`/membership-requests/${declineFor}/decline`, { method: 'POST', body: { reason } });
            setDeclineFor(null); setNote('Request declined and the applicant has been emailed.'); reloadAll();
          }}>Confirm decline</Action>
          <button className="ghost" onClick={() => setDeclineFor(null)}>Cancel</button>
        </div>
      )}

      <h3>Loan applications waiting for decision</h3>
      {applied && (
        <Table
          head={['Loan', 'Member', 'Amount', 'Term', 'Purpose', 'Applied', isAdmin ? '' : null].filter((x) => x !== null)}
          rows={applied.map((l) => [
            l.loanNo, l.memberName || '—', toKina(l.principal), `${l.termMonths} mo`, l.purpose || '—', fmtDate(l.appliedAt),
            ...(isAdmin ? [<span className="inline">
              <Action onRun={async () => { await api(`/loans/${l.id}/approve`, { method: 'POST' }); setNote('Loan approved and the member has been emailed.'); reloadAll(); }}>Approve</Action>
              <Action className="danger" onRun={async () => { const reasonText = window.prompt('Reason for rejection?') || ''; await api(`/loans/${l.id}/reject`, { method: 'POST', body: { reason: reasonText } }); reloadAll(); }}>Reject</Action>
            </span>] : []),
          ])}
          empty="No applications waiting."
        />
      )}
      {!isAdmin && <p className="muted small">Loan decisions are made by the administrator. Applications are recorded from the Loans page.</p>}

      <WardQueue isAdmin={isAdmin} />
      <MedicalQueue isAdmin={isAdmin} />

      <h3>Overdue instalments</h3>
      {arrears && (
        <Table
          head={['Loan', 'Member', 'Instalment', 'Due', 'Overdue']}
          rows={arrears.map((a) => [a.loanNo, a.memberName, `#${a.period}`, fmtDate(a.dueDate), toKina(a.amountOverdue)])}
          empty="No overdue instalments."
        />
      )}
    </>
  );
}

// ---------- Cash desk: deposits, withdrawals, share capital, repayments ----------
export function CashDeskPage() {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [member, setMember] = useState(null);
  const [receipt, setReceipt] = useState(null);

  useEffect(() => {
    const t = setTimeout(() => {
      api(`/members?q=${encodeURIComponent(q)}`).then((r) => setResults(r.slice(0, 10))).catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <>
      <h2>Cash desk</h2>
      <div className="card">
        <Field label="Find member by name or member number">
          <input className="search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. Kepas or M1002" />
        </Field>
        {results.length > 0 && !member && (
          <div className="pick-list">
            {results.map((m) => (
              <button key={m.id} className="pick" onClick={() => { setMember(m); setReceipt(null); }}>
                <b>{m.fullName}</b> <span className="muted small">{m.memberNo} · savings {toKina(m.savingsBalance)}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {receipt && (
        <div className="card receipt">
          <div className="small muted">Receipt</div>
          <div><b>{receipt.title}</b></div>
          <div className="small">{receipt.lines.map((l) => <div key={l}>{l}</div>)}</div>
          <div className="small muted">{new Date().toLocaleString('en-GB')}</div>
        </div>
      )}

      {member && (
        <CashMember
          memberId={member.id}
          onClear={() => { setMember(null); setQ(''); }}
          onReceipt={setReceipt}
        />
      )}
    </>
  );
}

function CashMember({ memberId, onClear, onReceipt }) {
  const { data: m, error, reload } = useData(`/members/${memberId}`, [memberId]);
  const { data: accounts, reload: reloadAccounts } = useData(`/savings/accounts?memberId=${memberId}`, [memberId]);
  const { data: loans, reload: reloadLoans } = useData(`/loans?memberId=${memberId}&status=disbursed`, [memberId]);
  const [accountId, setAccountId] = useState('');
  const [savType, setSavType] = useState('deposit');
  const [savAmount, setSavAmount] = useState('');
  const [savRef, setSavRef] = useState('');
  const [shareType, setShareType] = useState('subscription');
  const [shareAmount, setShareAmount] = useState('');
  const [loanId, setLoanId] = useState('');
  const [repayAmount, setRepayAmount] = useState('');

  useEffect(() => { if (accounts?.length && !accountId) setAccountId(accounts[0].id); }, [accounts, accountId]);
  useEffect(() => { if (loans?.length && !loanId) setLoanId(loans[0].id); }, [loans, loanId]);

  if (error) return <div className="error">{error}</div>;
  if (!m) return <div className="muted">Loading member…</div>;

  const refresh = () => { reload(); reloadAccounts(); reloadLoans(); };

  return (
    <>
      <div className="card member-head">
        <div>
          <h3>{m.fullName} <span className="muted small">{m.memberNo}</span></h3>
          <div className="small">Share capital {toKina(m.shareBalance)} · Savings {toKina(m.savingsBalance)} · Status <Badge status={m.status} /></div>
        </div>
        <button className="ghost" onClick={onClear}>Change member</button>
      </div>

      <div className="grid3">
        <div className="card">
          <h3>Savings</h3>
          {accounts?.length ? (
            <>
              <Field label="Account">
                <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.accountNo} · {toKina(a.balance)}</option>)}
                </select>
              </Field>
              <Field label="Type">
                <select value={savType} onChange={(e) => setSavType(e.target.value)}>
                  <option value="deposit">Deposit</option>
                  <option value="withdrawal">Withdrawal</option>
                </select>
              </Field>
              <Field label="Amount (K)"><input type="number" min="0" step="0.01" value={savAmount} onChange={(e) => setSavAmount(e.target.value)} /></Field>
              <Field label="Receipt number"><input value={savRef} onChange={(e) => setSavRef(e.target.value)} /></Field>
              <Action onRun={async () => {
                const r = await api(`/savings/accounts/${accountId}/transactions`, { method: 'POST', body: { type: savType, amount: toToea(savAmount), reference: savRef } });
                onReceipt({
                  title: savType === 'deposit' ? 'Savings deposit' : 'Savings withdrawal',
                  lines: [`${m.fullName} (${m.memberNo})`, `Amount ${toKina(toToea(savAmount))}`, `Reference ${savRef || '—'}`, `New balance ${toKina(r.balance)}`],
                });
                setSavAmount(''); setSavRef(''); refresh();
              }}>Post {savType}</Action>
            </>
          ) : (
            <div className="muted small">No savings account yet. <Action className="ghost" onRun={async () => { await api('/savings/accounts', { method: 'POST', body: { memberId } }); reloadAccounts(); }}>Open one</Action></div>
          )}
        </div>

        <div className="card">
          <h3>Share capital</h3>
          <Field label="Type">
            <select value={shareType} onChange={(e) => setShareType(e.target.value)}>
              <option value="subscription">Buy shares</option>
              <option value="withdrawal">Withdraw shares</option>
            </select>
          </Field>
          <Field label="Amount (K)"><input type="number" min="0" step="0.01" value={shareAmount} onChange={(e) => setShareAmount(e.target.value)} /></Field>
          <Action onRun={async () => {
            await api(`/members/${memberId}/shares`, { method: 'POST', body: { type: shareType, amount: toToea(shareAmount) } });
            onReceipt({
              title: shareType === 'subscription' ? 'Share purchase' : 'Share withdrawal',
              lines: [`${m.fullName} (${m.memberNo})`, `Amount ${toKina(toToea(shareAmount))}`],
            });
            setShareAmount(''); refresh();
          }}>Record {shareType === 'subscription' ? 'purchase' : 'withdrawal'}</Action>
        </div>

        <div className="card">
          <h3>Loan repayment</h3>
          {loans?.length ? (
            <>
              <Field label="Loan">
                <select value={loanId} onChange={(e) => setLoanId(e.target.value)}>
                  {loans.map((l) => <option key={l.id} value={l.id}>{l.loanNo} · principal {toKina(l.principal)}</option>)}
                </select>
              </Field>
              <Field label="Amount (K)"><input type="number" min="0" step="0.01" value={repayAmount} onChange={(e) => setRepayAmount(e.target.value)} /></Field>
              <Action onRun={async () => {
                const r = await api(`/loans/${loanId}/repayments`, { method: 'POST', body: { amount: toToea(repayAmount) } });
                onReceipt({
                  title: 'Loan repayment',
                  lines: [`${m.fullName} (${m.memberNo})`, `Paid ${toKina(r.applied)}`, `Outstanding ${toKina(r.outstanding)}${r.closed ? ' (loan cleared)' : ''}`],
                });
                setRepayAmount(''); refresh();
              }}>Record repayment</Action>
            </>
          ) : <div className="muted small">No active loans for this member.</div>}
        </div>
      </div>
    </>
  );
}

// ---------- Loan products (administrator): create products and change rates ----------
export function ProductsPanel() {
  const { data: products, error, reload } = useData('/loan-products', []);
  const [f, setF] = useState({ name: '', description: '', annualRatePct: '12', method: 'reducing', maxAmount: '', maxTermMonths: '36' });
  if (error) return <div className="error">{error}</div>;
  return (
    <>
      <h3>Loan products</h3>
      <p className="muted small">Products are shown to members on the loan market. A change to a rate applies to new applications only.</p>
      {products && (
        <Table
          head={['Product', 'Rate', 'Method', 'Max amount', 'Max term', 'Status', '']}
          rows={products.map((p) => [
            p.name, `${p.annualRatePct}%`, p.method, toKina(p.maxAmount), `${p.maxTermMonths} mo`, <Badge status={p.active ? 'active' : 'closed'} />,
            <Action className="ghost" onRun={async () => { await api(`/loan-products/${p.id}`, { method: 'PATCH', body: { active: !p.active } }); reload(); }}>
              {p.active ? 'Hide' : 'Show'}
            </Action>,
          ])}
        />
      )}
      <div className="card form-grid">
        <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Annual rate %"><input type="number" min="0" step="0.1" value={f.annualRatePct} onChange={(e) => setF({ ...f, annualRatePct: e.target.value })} /></Field>
        <Field label="Method">
          <select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>
            <option value="reducing">Reducing balance</option>
            <option value="flat">Flat rate</option>
          </select>
        </Field>
        <Field label="Max amount (K)"><input type="number" min="0" value={f.maxAmount} onChange={(e) => setF({ ...f, maxAmount: e.target.value })} /></Field>
        <Field label="Max term (months)"><input type="number" min="1" max="120" value={f.maxTermMonths} onChange={(e) => setF({ ...f, maxTermMonths: e.target.value })} /></Field>
        <Field label="Description"><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Action onRun={async () => {
          await api('/loan-products', { method: 'POST', body: { ...f, maxAmount: toToea(f.maxAmount), annualRatePct: Number(f.annualRatePct), maxTermMonths: Number(f.maxTermMonths) } });
          setF({ ...f, name: '', description: '' }); reload();
        }}>Add product</Action>
      </div>
    </>
  );
}

// ---------- Ward registrations from the PNG LLG ward platform ----------
export function WardQueue({ isAdmin }) {
  const { data, error, reload } = useData('/integrations/ward/pending', []);
  const [note, setNote] = useState('');
  if (error) return <div className="error">{error}</div>;
  return (
    <>
      <h3>Ward registrations to review</h3>
      <p className="muted small">People sent by the PNG LLG ward platform. They are not members until approved.</p>
      {note && <div className="card small">{note}</div>}
      {data && (
        <Table
          head={['Member no', 'Name', 'Born', 'Sex', 'Relation', 'Household', 'Village', '']}
          rows={data.map((p) => [
            p.memberNo, p.fullName, fmtDate(p.dateOfBirth), p.sex || '—', p.relationshipToHead || '—',
            p.householdRef || '—', p.village || '—',
            <span className="inline">
              <Action onRun={async () => {
                const r = await api(`/integrations/ward/members/${p.id}/approve`, { method: 'POST', body: { invite: Boolean(p.email) } });
                setNote(`${p.fullName} approved.${r.invitation ? ' Portal invitation emailed.' : ''}`); reload();
              }}>Approve</Action>
              <Action className="ghost" onRun={async () => { await api(`/integrations/ward/members/${p.id}/reject`, { method: 'POST', body: { reason: 'Not confirmed' } }); reload(); }}>Reject</Action>
            </span>,
          ])}
          empty="No ward registrations waiting."
        />
      )}
    </>
  );
}

// ---------- Medical withdrawal requests from student investment accounts ----------
export function MedicalQueue({ isAdmin }) {
  const { data, error, reload } = useData('/students/medical-requests', []);
  if (error) return <div className="error">{error}</div>;
  return (
    <>
      <h3>Medical withdrawal requests</h3>
      <p className="muted small">Requests from parents for money held in a child's investment account. Approval moves the money to the parent's savings.</p>
      {data && (
        <Table
          head={['Child', 'Parent', 'Amount', 'Reason', 'Evidence', 'Status', 'Date', isAdmin ? '' : null].filter((x) => x !== null)}
          rows={data.map((r) => [
            r.childName, r.guardianName, toKina(r.amount), r.reason, r.evidenceNote || '—', <Badge status={r.status} />, fmtDate(r.createdAt),
            ...(isAdmin && r.status === 'pending' ? [<span className="inline">
              <Action onRun={async () => { await api(`/students/medical-requests/${r.id}/approve`, { method: 'POST', body: {} }); reload(); }}>Approve</Action>
              <Action className="ghost" onRun={async () => { await api(`/students/medical-requests/${r.id}/decline`, { method: 'POST', body: { note: 'Not supported by evidence' } }); reload(); }}>Decline</Action>
            </span>] : isAdmin ? [''] : []),
          ])}
          empty="No medical requests."
        />
      )}
    </>
  );
}

// ---------- Investment products and distributions (administrator) ----------
export function InvestmentProductsPanel() {
  const { data, error, reload } = useData('/investment-products', []);
  const [f, setF] = useState({ name: '', kind: 'fixed_deposit', annualRatePct: '6', termMonths: '12', minAmount: '10', description: '' });
  const [dist, setDist] = useState({ id: '', amount: '', note: '' });
  const [msg, setMsg] = useState('');
  if (error) return <div className="error">{error}</div>;
  return (
    <>
      <h3>Other investment products</h3>
      <p className="muted small">Fixed deposits pay interest at maturity. For shares and property, declare a return and it is shared by holders in proportion to what they hold.</p>
      {msg && <div className="card small">{msg}</div>}
      {data && (
        <Table
          head={['Product', 'Type', 'Rate', 'Term', 'Minimum', 'Status']}
          rows={data.map((p) => [p.name, p.kindLabel, `${p.annualRatePct}%`, p.termMonths ? `${p.termMonths} mo` : '—', toKina(p.minAmount), <Badge status={p.status === 'open' ? 'active' : 'closed'} />])}
          empty="No products yet."
        />
      )}
      <div className="card form-grid">
        <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Type">
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            <option value="fixed_deposit">Fixed deposit</option>
            <option value="project_shares">Project or business shares</option>
            <option value="agri_shares">Agriculture co-operative shares</option>
            <option value="property">Property or land</option>
          </select>
        </Field>
        <Field label="Rate % p.a. (fixed deposits)"><input type="number" min="0" step="0.1" value={f.annualRatePct} onChange={(e) => setF({ ...f, annualRatePct: e.target.value })} /></Field>
        {f.kind === 'fixed_deposit' && <Field label="Term (months)"><input type="number" min="1" value={f.termMonths} onChange={(e) => setF({ ...f, termMonths: e.target.value })} /></Field>}
        <Field label="Minimum (K)"><input type="number" min="0" value={f.minAmount} onChange={(e) => setF({ ...f, minAmount: e.target.value })} /></Field>
        <Field label="Description"><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Action onRun={async () => {
          await api('/investment-products', { method: 'POST', body: { ...f, annualRatePct: Number(f.annualRatePct), termMonths: Number(f.termMonths), minAmount: toToea(f.minAmount) } });
          setF({ ...f, name: '', description: '' }); reload();
        }}>Add product</Action>
      </div>

      <div className="card form-grid">
        <Field label="Declare a return for">
          <select value={dist.id} onChange={(e) => setDist({ ...dist, id: e.target.value })}>
            <option value="">Choose a product…</option>
            {(data || []).filter((p) => p.kind !== 'fixed_deposit').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Total return (K)"><input type="number" min="0" step="0.01" value={dist.amount} onChange={(e) => setDist({ ...dist, amount: e.target.value })} /></Field>
        <Field label="Note"><input value={dist.note} onChange={(e) => setDist({ ...dist, note: e.target.value })} /></Field>
        <Action onRun={async () => {
          const r = await api(`/investment-products/${dist.id}/distribute`, { method: 'POST', body: { amount: toToea(dist.amount), note: dist.note } });
          setMsg(`Return of ${toKina(r.amount)} shared among ${r.holders} holder(s).`); setDist({ id: '', amount: '', note: '' });
        }}>Share return</Action>
        <Action className="ghost" onRun={async () => {
          const r = await api('/investment-products/process-maturities', { method: 'POST' });
          setMsg(`Fixed deposits checked: ${r.checked}; paid out: ${r.paid}.`); reload();
        }}>Pay matured fixed deposits now</Action>
      </div>
    </>
  );
}

// ---------- Integration keys for the PNG LLG ward platform (administrator) ----------
export function IntegrationKeysPanel() {
  const { data, error, reload } = useData('/integrations/keys', []);
  const [name, setName] = useState('PNG LLG Ward Platform');
  const [created, setCreated] = useState(null);
  if (error) return <div className="error">{error}</div>;
  return (
    <>
      <h3>Ward platform connection</h3>
      <p className="muted small">The ward platform sends households to <span className="mono">POST /api/integrations/ward/households</span> with the header <span className="mono">X-Api-Key</span>. The key is shown once; copy it into the platform's settings.</p>
      {created && (
        <div className="card">
          <div>New key for <b>{created.name}</b>. Copy it now; it will not be shown again:</div>
          <div className="mono">{created.key}</div>
        </div>
      )}
      {data && (
        <Table
          head={['Name', 'Created', 'Last used', 'Status', '']}
          rows={data.map((k) => [k.name, fmtDate(k.created_at), k.last_used_at ? new Date(k.last_used_at).toLocaleString('en-GB') : 'Never', <Badge status={k.active ? 'active' : 'closed'} />,
            k.active ? <Action className="ghost" onRun={async () => { await api(`/integrations/keys/${k.id}/revoke`, { method: 'POST' }); reload(); }}>Revoke</Action> : null])}
          empty="No keys yet."
        />
      )}
      <div className="card form-row">
        <input value={name} onChange={(e) => setName(e.target.value)} />
        <Action onRun={async () => { const r = await api('/integrations/keys', { method: 'POST', body: { name } }); setCreated(r); reload(); }}>Create key</Action>
      </div>
    </>
  );
}
