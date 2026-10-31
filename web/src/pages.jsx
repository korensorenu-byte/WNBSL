import { useEffect, useState, useCallback } from 'react';
import { api, toKina, toToea, fmtDate } from './api.js';

// ---------- shared UI helpers ----------
function useData(path, deps = []) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const reload = useCallback(() => {
    setError('');
    return api(path).then(setData).catch((e) => setError(e.message));
  }, [path]);
  useEffect(() => { reload(); }, [reload, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, reload };
}

function Action({ onRun, children, className = 'primary', disabled = false }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  async function run() {
    setBusy(true);
    setMsg('');
    try { await onRun(); } catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }
  return (
    <span className="action">
      <button className={className} onClick={run} disabled={busy || disabled}>{busy ? 'Working…' : children}</button>
      {msg && <span className="error small">{msg}</span>}
    </span>
  );
}

function Field({ label, children }) {
  return <label className="field">{label}{children}</label>;
}

function Badge({ status }) {
  return <span className={`badge ${status}`}>{String(status).replace('_', ' ')}</span>;
}

function Table({ head, rows, empty = 'Nothing to show yet.' }) {
  if (!rows.length) return <div className="card muted">{empty}</div>;
  return (
    <div className="card table-wrap">
      <table>
        <thead><tr>{head.map((h) => <th key={h}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

// ---------- Members ----------
export function MembersPage({ user }) {
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState(null);
  const canWrite = ['admin', 'officer'].includes(user.role);
  const { data, error, reload } = useData(`/members?q=${encodeURIComponent(q)}`, [q]);

  if (user.role === 'member') return <MemberDetail id={user.memberId} />;
  if (selected) return <MemberDetail id={selected} onBack={() => { setSelected(null); reload(); }} canWrite={canWrite} />;

  return (
    <>
      <div className="page-head">
        <h2>Members</h2>
        {canWrite && <NewMember onCreated={reload} />}
      </div>
      <input className="search" placeholder="Search by name or member number" value={q} onChange={(e) => setQ(e.target.value)} />
      {error && <div className="error">{error}</div>}
      {data && (
        <Table
          head={['Member no', 'Name', 'Status', 'Share capital', 'Savings', '']}
          rows={data.map((m) => [
            m.memberNo, m.fullName, <Badge status={m.status} />, toKina(m.shareBalance), toKina(m.savingsBalance),
            <button className="ghost" onClick={() => setSelected(m.id)}>Open</button>,
          ])}
        />
      )}
    </>
  );
}

function NewMember({ onCreated }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ fullName: '', phone: '', village: '', address: '', idType: '', idNumber: '' });
  if (!open) return <button className="primary" onClick={() => setOpen(true)}>New member</button>;
  return (
    <div className="card form-grid">
      {Object.keys(f).map((k) => (
        <Field key={k} label={k.replace(/([A-Z])/g, ' $1')}>
          <input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
        </Field>
      ))}
      <Action onRun={async () => { await api('/members', { method: 'POST', body: f }); setOpen(false); onCreated(); }}>
        Save member
      </Action>
    </div>
  );
}

function MemberDetail({ id, onBack, canWrite }) {
  const { data, error, reload } = useData(`/members/${id}`, [id]);
  const [amount, setAmount] = useState('');
  const [type, setType] = useState('subscription');
  const [acctProduct, setAcctProduct] = useState('Regular Savings');
  const { data: accounts, reload: reloadAccounts } = useData(`/savings/accounts?memberId=${id}`, [id]);
  if (error) return <div className="error">{error}</div>;
  if (!data) return <div className="muted">Loading…</div>;

  return (
    <>
      {onBack && <button className="ghost" onClick={onBack}>← Back to members</button>}
      <h2>{data.fullName} <span className="muted small">{data.memberNo}</span></h2>
      <div className="stats">
        <div className="card stat"><div className="muted small">Share capital</div><div className="stat-value">{toKina(data.shareBalance)}</div></div>
        <div className="card stat"><div className="muted small">Savings</div><div className="stat-value">{toKina(data.savingsBalance)}</div></div>
        <div className="card stat"><div className="muted small">Joined</div><div className="stat-value small">{fmtDate(data.joinedOn)}</div></div>
      </div>

      {canWrite && (
        <div className="card form-row">
          <h3>Share capital</h3>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="subscription">Subscription (deposit)</option>
            <option value="withdrawal">Withdrawal</option>
          </select>
          <input type="number" min="0" step="0.01" placeholder="Amount (K)" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <Action onRun={async () => {
            await api(`/members/${id}/shares`, { method: 'POST', body: { type, amount: toToea(amount) } });
            setAmount(''); reload();
          }}>Record</Action>
        </div>
      )}

      <h3>Savings accounts</h3>
      <Table
        head={['Account', 'Product', 'Status', 'Balance']}
        rows={(accounts || []).map((a) => [a.accountNo, a.product, <Badge status={a.status} />, toKina(a.balance)])}
        empty="No savings accounts yet."
      />
      {canWrite && (
        <div className="card form-row">
          <input value={acctProduct} onChange={(e) => setAcctProduct(e.target.value)} />
          <Action onRun={async () => { await api('/savings/accounts', { method: 'POST', body: { memberId: id, product: acctProduct } }); reloadAccounts(); }}>
            Open savings account
          </Action>
        </div>
      )}
      <h3>Details</h3>
      <div className="card small">
        Phone: {data.phone || '—'} · Village: {data.village || '—'} · Status: {data.status}
      </div>
    </>
  );
}

// ---------- Savings ----------
export function SavingsPage({ user }) {
  const { data, error, reload } = useData('/savings/accounts');
  const [openId, setOpenId] = useState(null);
  if (openId) return <SavingsAccount id={openId} user={user} onBack={() => { setOpenId(null); reload(); }} />;
  return (
    <>
      <h2>Savings accounts</h2>
      {error && <div className="error">{error}</div>}
      {data && (
        <Table
          head={['Account', 'Member', 'Product', 'Status', 'Balance', '']}
          rows={data.map((a) => [
            a.accountNo, `${a.memberName} (${a.memberNo})`, a.product, <Badge status={a.status} />, toKina(a.balance),
            <button className="ghost" onClick={() => setOpenId(a.id)}>Open</button>,
          ])}
        />
      )}
    </>
  );
}

function SavingsAccount({ id, user, onBack }) {
  const { data, error, reload } = useData(`/savings/accounts/${id}`, [id]);
  const [amount, setAmount] = useState('');
  const [type, setType] = useState('deposit');
  const [ref, setRef] = useState('');
  const canWrite = ['admin', 'officer'].includes(user.role);
  if (error) return <div className="error">{error}</div>;
  if (!data) return <div className="muted">Loading…</div>;
  return (
    <>
      <button className="ghost" onClick={onBack}>← Back to accounts</button>
      <h2>{data.accountNo} <span className="muted small">{data.memberName}</span></h2>
      <div className="stats">
        <div className="card stat"><div className="muted small">Balance</div><div className="stat-value">{toKina(data.balance)}</div></div>
        <div className="card stat"><div className="muted small">Status</div><div className="stat-value small"><Badge status={data.status} /></div></div>
      </div>
      {canWrite && (
        <div className="card form-row">
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="deposit">Deposit</option>
            <option value="withdrawal">Withdrawal</option>
          </select>
          <input type="number" min="0" step="0.01" placeholder="Amount (K)" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <input placeholder="Reference / receipt no." value={ref} onChange={(e) => setRef(e.target.value)} />
          <Action onRun={async () => {
            await api(`/savings/accounts/${id}/transactions`, { method: 'POST', body: { type, amount: toToea(amount), reference: ref } });
            setAmount(''); setRef(''); reload();
          }}>Post transaction</Action>
        </div>
      )}
      <h3>Transactions</h3>
      <Table
        head={['Date', 'Type', 'Reference', 'Amount']}
        rows={data.transactions.map((t) => [
          fmtDate(t.createdAt), t.type, t.reference || '—',
          (t.type === 'withdrawal' ? '−' : '+') + toKina(t.amount),
        ])}
        empty="No transactions yet."
      />
    </>
  );
}

// ---------- Loans ----------
export function LoansPage({ user }) {
  const [filter, setFilter] = useState('');
  const [openId, setOpenId] = useState(null);
  const { data, error, reload } = useData(`/loans${filter ? `?status=${filter}` : ''}`, [filter]);
  const { data: arrears } = useData(user.role === 'member' ? '/loans?status=none' : '/loans/arrears', []);
  if (openId) return <LoanDetail id={openId} user={user} onBack={() => { setOpenId(null); reload(); }} />;

  return (
    <>
      <div className="page-head">
        <h2>Loans</h2>
        {user.role === 'member' && <LoanApplication memberId={user.memberId} onDone={reload} />}
        {['admin', 'officer'].includes(user.role) && <StaffLoanApplication onDone={reload} />}
      </div>
      <div className="filters">
        {['', 'applied', 'approved', 'disbursed', 'closed', 'rejected'].map((s) => (
          <button key={s} className={filter === s ? 'chip active' : 'chip'} onClick={() => setFilter(s)}>{s || 'All'}</button>
        ))}
      </div>
      {error && <div className="error">{error}</div>}
      {data && (
        <Table
          head={['Loan no', 'Member', 'Amount', 'Rate', 'Term', 'Status', '']}
          rows={data.map((l) => [
            l.loanNo, l.memberName || '—', toKina(l.principal), `${l.annualRatePct}%`, `${l.termMonths} mo`,
            <Badge status={l.status} />,
            <button className="ghost" onClick={() => setOpenId(l.id)}>Open</button>,
          ])}
        />
      )}
      {arrears && arrears.length > 0 && user.role !== 'member' && (
        <>
          <h3>Overdue instalments</h3>
          <Table
            head={['Loan', 'Member', 'Instalment', 'Due', 'Overdue']}
            rows={arrears.map((a) => [a.loanNo, a.memberName, `#${a.period}`, fmtDate(a.dueDate), toKina(a.amountOverdue)])}
          />
        </>
      )}
    </>
  );
}

function LoanApplication({ memberId, onDone }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [term, setTerm] = useState(12);
  const [purpose, setPurpose] = useState('');
  const [elig, setElig] = useState(null);
  useEffect(() => { if (open) api(`/loans/eligibility/${memberId}`).then(setElig).catch(() => {}); }, [open, memberId]);
  if (!open) return <button className="primary" onClick={() => setOpen(true)}>Apply for loan</button>;
  return (
    <div className="card form-grid">
      {elig && <div className="small muted">You can borrow up to <b>{toKina(elig.maxLoan)}</b> over up to {elig.maxTermMonths} months at {elig.annualRatePct}% p.a.</div>}
      <Field label="Amount (K)"><input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
      <Field label="Term (months)"><input type="number" min="1" value={term} onChange={(e) => setTerm(e.target.value)} /></Field>
      <Field label="Purpose"><input value={purpose} onChange={(e) => setPurpose(e.target.value)} /></Field>
      <Action onRun={async () => {
        await api('/loans', { method: 'POST', body: { amount: toToea(amount), termMonths: Number(term), purpose } });
        setOpen(false); onDone();
      }}>Submit application</Action>
    </div>
  );
}

function StaffLoanApplication({ onDone }) {
  const [open, setOpen] = useState(false);
  const [memberId, setMemberId] = useState('');
  const [amount, setAmount] = useState('');
  const [term, setTerm] = useState(12);
  const [purpose, setPurpose] = useState('');
  const { data: members } = useData('/members', []);
  if (!open) return <button className="primary" onClick={() => setOpen(true)}>New loan application</button>;
  return (
    <div className="card form-grid">
      <Field label="Member">
        <select value={memberId} onChange={(e) => setMemberId(e.target.value)}>
          <option value="">Select member…</option>
          {(members || []).map((m) => <option key={m.id} value={m.id}>{m.memberNo} – {m.fullName}</option>)}
        </select>
      </Field>
      <Field label="Amount (K)"><input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
      <Field label="Term (months)"><input type="number" min="1" value={term} onChange={(e) => setTerm(e.target.value)} /></Field>
      <Field label="Purpose"><input value={purpose} onChange={(e) => setPurpose(e.target.value)} /></Field>
      <Action onRun={async () => {
        await api('/loans', { method: 'POST', body: { memberId, amount: toToea(amount), termMonths: Number(term), purpose } });
        setOpen(false); onDone();
      }}>Submit application</Action>
    </div>
  );
}

function LoanDetail({ id, user, onBack }) {
  const { data, error, reload } = useData(`/loans/${id}`, [id]);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const isAdmin = user.role === 'admin';
  const canRecord = ['admin', 'officer'].includes(user.role);
  if (error) return <div className="error">{error}</div>;
  if (!data) return <div className="muted">Loading…</div>;

  return (
    <>
      <button className="ghost" onClick={onBack}>← Back to loans</button>
      <h2>{data.loanNo} <Badge status={data.status} /></h2>
      <div className="stats">
        <div className="card stat"><div className="muted small">Principal</div><div className="stat-value">{toKina(data.principal)}</div></div>
        <div className="card stat"><div className="muted small">Outstanding</div><div className="stat-value">{toKina(data.outstanding || 0)}</div></div>
        <div className="card stat"><div className="muted small">Rate / term</div><div className="stat-value small">{data.annualRatePct}% · {data.termMonths} mo · {data.method}</div></div>
        <div className="card stat"><div className="muted small">Overdue instalments</div><div className="stat-value">{data.arrears}</div></div>
      </div>
      <div className="card small">Member: {data.memberName} ({data.memberNo}) · Purpose: {data.purpose || '—'}</div>

      {isAdmin && data.status === 'applied' && (
        <div className="card form-row">
          <Action onRun={async () => { await api(`/loans/${id}/approve`, { method: 'POST' }); reload(); }}>Approve</Action>
          <input placeholder="Reason for rejection" value={reason} onChange={(e) => setReason(e.target.value)} />
          <Action className="danger" onRun={async () => { await api(`/loans/${id}/reject`, { method: 'POST', body: { reason } }); reload(); }}>Reject</Action>
        </div>
      )}
      {isAdmin && data.status === 'approved' && (
        <div className="card form-row">
          <Action onRun={async () => { await api(`/loans/${id}/disburse`, { method: 'POST', body: {} }); reload(); }}>Disburse and create schedule</Action>
        </div>
      )}
      {canRecord && data.status === 'disbursed' && (
        <div className="card form-row">
          <input type="number" min="0" step="0.01" placeholder="Repayment (K)" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <Action onRun={async () => { await api(`/loans/${id}/repayments`, { method: 'POST', body: { amount: toToea(amount) } }); setAmount(''); reload(); }}>
            Record repayment
          </Action>
        </div>
      )}

      <h3>Repayment schedule</h3>
      <Table
        head={['#', 'Due', 'Principal', 'Interest', 'Paid', 'Balance']}
        rows={data.installments.map((i) => {
          const due = i.principalDue + i.interestDue;
          const paid = i.principalPaid + i.interestPaid;
          return [i.period, fmtDate(i.dueDate), toKina(i.principalDue), toKina(i.interestDue), toKina(paid), toKina(due - paid)];
        })}
        empty="Schedule is created when the loan is disbursed."
      />
      <h3>Repayments received</h3>
      <Table head={['Date', 'Amount']} rows={data.repayments.map((r) => [fmtDate(r.paidOn), toKina(r.amount)])} empty="No repayments yet." />
    </>
  );
}

// ---------- Investments ----------
export function InvestmentsPage({ user }) {
  const { data, error, reload } = useData('/investments');
  const isAdmin = user.role === 'admin';
  return (
    <>
      <div className="page-head">
        <h2>Investments</h2>
        {isAdmin && <NewInvestment onCreated={reload} />}
      </div>
      {error && <div className="error">{error}</div>}
      {data && (
        <Table
          head={['Name', 'Category', 'Principal', 'Expected p.a.', 'Returns', 'Distributed', 'Status', '']}
          rows={data.map((v) => [
            v.name, v.category.replace('_', ' '), toKina(v.principal), `${v.expectedAnnualReturnPct}%`,
            toKina(v.returnsReceived), toKina(v.distributed), <Badge status={v.status} />,
            isAdmin ? <IncomeButton id={v.id} onDone={reload} /> : null,
          ])}
          empty="No investments recorded."
        />
      )}
    </>
  );
}

function NewInvestment({ onCreated }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: '', category: 'other', principal: '', expectedAnnualReturnPct: '0', notes: '' });
  if (!open) return <button className="primary" onClick={() => setOpen(true)}>New investment</button>;
  return (
    <div className="card form-grid">
      <Field label="Name"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
      <Field label="Category">
        <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
          {['property', 'shares', 'business', 'fixed_deposit', 'agriculture', 'other'].map((c) => <option key={c}>{c}</option>)}
        </select>
      </Field>
      <Field label="Principal (K)"><input type="number" min="0" value={f.principal} onChange={(e) => setF({ ...f, principal: e.target.value })} /></Field>
      <Field label="Expected return % p.a."><input type="number" min="0" value={f.expectedAnnualReturnPct} onChange={(e) => setF({ ...f, expectedAnnualReturnPct: e.target.value })} /></Field>
      <Field label="Notes"><input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      <Action onRun={async () => {
        await api('/investments', { method: 'POST', body: { ...f, principal: toToea(f.principal), expectedAnnualReturnPct: Number(f.expectedAnnualReturnPct) } });
        setOpen(false); onCreated();
      }}>Save investment</Action>
    </div>
  );
}

function IncomeButton({ id, onDone }) {
  const [amount, setAmount] = useState('');
  const [kind, setKind] = useState('return');
  return (
    <span className="inline">
      <select value={kind} onChange={(e) => setKind(e.target.value)}>
        <option value="return">Return</option>
        <option value="distribution">Distribution</option>
      </select>
      <input type="number" min="0" step="0.01" placeholder="K" value={amount} onChange={(e) => setAmount(e.target.value)} className="tiny" />
      <Action className="ghost" onRun={async () => {
        await api(`/investments/${id}/income`, { method: 'POST', body: { kind, amount: toToea(amount) } });
        setAmount(''); onDone();
      }}>Add</Action>
    </span>
  );
}

// ---------- Settings, users, audit ----------
export function AdminPage({ user }) {
  const isAdmin = user.role === 'admin';
  const { data: settings, error, reload } = useData('/settings');
  const { data: users, reload: reloadUsers } = useData(isAdmin ? '/users' : '/settings', []);
  const { data: audit } = useData('/audit');
  const [draft, setDraft] = useState(null);

  if (error) return <div className="error">{error}</div>;
  if (!settings) return <div className="muted">Loading…</div>;
  const values = draft || settings;
  const set = (k, v) => setDraft({ ...values, [k]: v });

  const fields = [
    ['society_name', 'Society name', 'text'],
    ['savings_interest_rate_pct', 'Savings interest % p.a. (credited monthly)', 'number'],
    ['loan_interest_rate_pct', 'Loan interest % p.a.', 'number'],
    ['loan_method', 'Loan method (reducing / flat)', 'text'],
    ['loan_max_multiple', 'Max loan = savings + shares × ', 'number'],
    ['loan_max_amount_toea', 'Loan cap (toea, 0 = none)', 'number'],
    ['loan_max_term_months', 'Maximum term (months)', 'number'],
    ['min_savings_balance_toea', 'Minimum savings balance (toea)', 'number'],
  ];

  return (
    <>
      <h2>Settings & users</h2>
      {isAdmin && (
        <div className="card">
          <h3>Society rules</h3>
          <p className="muted small">Changes apply to new transactions immediately. Existing loan schedules are not recalculated.</p>
          <div className="form-grid">
            {fields.map(([k, label, type]) => (
              <Field key={k} label={label}>
                <input type={type} value={values[k]} onChange={(e) => set(k, type === 'number' ? Number(e.target.value) : e.target.value)} />
              </Field>
            ))}
          </div>
          <div className="form-row">
            <Action disabled={!draft} onRun={async () => {
              const body = Object.fromEntries(Object.keys(DEFAULTS_FOR_PATCH).map((k) => [k, draft[k]]));
              await api('/settings', { method: 'PUT', body });
              setDraft(null); reload();
            }}>Save rules</Action>
          </div>
        </div>
      )}
      {!isAdmin && (
        <div className="card small">
          Loan rate {settings.loan_interest_rate_pct}% · Savings rate {settings.savings_interest_rate_pct}% · Max multiple {settings.loan_max_multiple}×
        </div>
      )}

      {isAdmin && users && (
        <>
          <h3>Users</h3>
          <NewUser onCreated={reloadUsers} />
          <Table
            head={['Name', 'Email', 'Role', 'Active', '']}
            rows={users.map((u) => [
              u.fullName, u.email, u.role, u.active ? 'Yes' : 'No',
              u.id !== user.id ? (
                <Action className="ghost" onRun={async () => { await api(`/users/${u.id}`, { method: 'PATCH', body: { active: !u.active } }); reloadUsers(); }}>
                  {u.active ? 'Deactivate' : 'Activate'}
                </Action>
              ) : null,
            ])}
          />
        </>
      )}

      {audit && (
        <>
          <h3>Audit trail (latest 300)</h3>
          <Table
            head={['When', 'Who', 'Action', 'Entity']}
            rows={audit.slice(0, 100).map((a) => [new Date(a.created_at).toLocaleString(), a.email || 'system', a.action, `${a.entity} ${a.entity_id ? a.entity_id.slice(0, 8) : ''}`])}
          />
        </>
      )}
    </>
  );
}

const DEFAULTS_FOR_PATCH = {
  society_name: 0, savings_interest_rate_pct: 0, loan_interest_rate_pct: 0, loan_method: 0,
  loan_max_multiple: 0, loan_max_amount_toea: 0, loan_max_term_months: 0, min_savings_balance_toea: 0,
};

function NewUser({ onCreated }) {
  const [f, setF] = useState({ email: '', fullName: '', password: '', role: 'officer', memberId: '' });
  const [open, setOpen] = useState(false);
  if (!open) return <button className="ghost" onClick={() => setOpen(true)}>Add user</button>;
  return (
    <div className="card form-grid">
      {['email', 'fullName', 'password'].map((k) => (
        <Field key={k} label={k === 'fullName' ? 'Full name' : k}>
          <input type={k === 'password' ? 'password' : 'text'} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
        </Field>
      ))}
      <Field label="Role">
        <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
          {['admin', 'officer', 'auditor', 'member'].map((r) => <option key={r}>{r}</option>)}
        </select>
      </Field>
      {f.role === 'member' && (
        <Field label="Member ID (UUID)"><input value={f.memberId} onChange={(e) => setF({ ...f, memberId: e.target.value })} /></Field>
      )}
      <Action onRun={async () => { await api('/users', { method: 'POST', body: f }); setOpen(false); onCreated(); }}>Create user</Action>
    </div>
  );
}
