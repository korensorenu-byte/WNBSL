import { useEffect, useState } from 'react';
import { api, toKina, toToea, fmtDate } from './api.js';
import { useData, Action, Table, Field, Badge } from './pages.jsx';

// ---------- Other investments: fixed deposits, property, shares (not loans) ----------
export function OtherInvestments() {
  const { data: products, error: pErr } = useData('/investment-products', []);
  const { data: positions, reload } = useData('/investment-products/positions', []);
  const { data: s } = useData('/portal/summary', []);
  const [sel, setSel] = useState(null);
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  useEffect(() => { if (!accountId && s?.accounts?.[0]) setAccountId(s.accounts[0].id); }, [s]); // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = (products || []).find((p) => p.id === sel);
  return (
    <>
      <h2>Other investments</h2>
      <p className="muted small">These are not loans. Fixed deposits pay interest at maturity. Shares and property pay returns the Society declares, shared by holders.</p>
      {pErr && <div className="error">{pErr}</div>}

      <div className="grid3">
        {(products || []).map((p) => (
          <div key={p.id} className={`card ${sel === p.id ? 'selected' : ''}`}>
            <h3>{p.name}</h3>
            <div className="small muted">{p.kindLabel}</div>
            {p.kind === 'fixed_deposit'
              ? <div className="stat-value">{p.annualRatePct}% <span className="muted small">p.a. for {p.termMonths} months</span></div>
              : <div className="small">Returns declared by the Society, shared by holders</div>}
            <div className="small muted">Minimum {toKina(p.minAmount)}</div>
            <p className="small">{p.description}</p>
            <button className="ghost" onClick={() => { setSel(p.id); setAmount(''); }}>Invest</button>
          </div>
        ))}
      </div>

      {chosen && (
        <div className="card form-grid">
          <h3 className="wide">Invest in {chosen.name}</h3>
          <Field label="From savings account">
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {(s?.accounts || []).filter((a) => a.status === 'open').map((a) => <option key={a.id} value={a.id}>{a.accountNo} · {toKina(a.balance)}</option>)}
            </select>
          </Field>
          <Field label="Amount (K)"><input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Action onRun={async () => {
            const r = await api(`/investment-products/${chosen.id}/invest`, { method: 'POST', body: { amount: toToea(amount), savingsAccountId: accountId } });
            setAmount(''); setSel(null);
            alert(r.maturityOn ? `Invested. Matures on ${fmtDate(r.maturityOn)}.` : 'Invested.');
            reload();
          }}>Confirm investment</Action>
          <button className="ghost" onClick={() => setSel(null)}>Cancel</button>
        </div>
      )}

      <h3>My other investments</h3>
      <Table
        head={['Product', 'Type', 'Invested', 'Rate', 'Maturity', 'Income received', 'Status']}
        rows={(positions || []).map((p) => [
          p.productName, p.kindLabel, toKina(p.principal), `${p.ratePct}%`, p.maturityOn ? fmtDate(p.maturityOn) : '—',
          toKina(p.incomeReceived), <Badge status={p.status === 'matured' ? 'matured' : 'active'} />,
        ])}
        empty="You have no other investments yet."
      />
    </>
  );
}

// ---------- Children's accounts: parent opens and tops up student investment accounts ----------
export function ChildrenAccounts() {
  const { data: kids, error, reload } = useData('/students/mine', []);
  const { data: s } = useData('/portal/summary', []);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ childName: '', childDob: '', childEmail: '', initialAmount: '', sex: '' });
  const [fromAccount, setFromAccount] = useState('');
  const [medFor, setMedFor] = useState(null);
  const [med, setMed] = useState({ amount: '', reason: '', evidenceNote: '' });
  useEffect(() => { if (!fromAccount && s?.accounts?.[0]) setFromAccount(s.accounts[0].id); }, [s]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="page-head">
        <h2>Children's investment accounts</h2>
        <button className="primary" onClick={() => setOpen(!open)}>{open ? 'Close' : 'Open account for a child'}</button>
      </div>
      <p className="muted small">The money belongs to your child. You can add to it while they are under 18. At 18 the account passes to them, and they will receive an email invitation to their own login. Withdrawals before 18 are allowed only for approved medical needs.</p>
      {error && <div className="error">{error}</div>}

      {open && (
        <div className="card form-grid">
          <Field label="Child's full name"><input value={f.childName} onChange={(e) => setF({ ...f, childName: e.target.value })} /></Field>
          <Field label="Child's date of birth"><input type="date" value={f.childDob} onChange={(e) => setF({ ...f, childDob: e.target.value })} /></Field>
          <Field label="Child's email (for their login at 18)"><input type="email" value={f.childEmail} onChange={(e) => setF({ ...f, childEmail: e.target.value })} /></Field>
          <Field label="Opening amount (K)"><input type="number" min="0" step="0.01" value={f.initialAmount} onChange={(e) => setF({ ...f, initialAmount: e.target.value })} /></Field>
          <Field label="Pay from my savings account">
            <select value={fromAccount} onChange={(e) => setFromAccount(e.target.value)}>
              {(s?.accounts || []).filter((a) => a.status === 'open').map((a) => <option key={a.id} value={a.id}>{a.accountNo} · {toKina(a.balance)}</option>)}
            </select>
          </Field>
          <Action onRun={async () => {
            await api('/students', { method: 'POST', body: { ...f, initialAmount: f.initialAmount ? toToea(f.initialAmount) : 0, savingsAccountId: fromAccount } });
            setOpen(false); setF({ childName: '', childDob: '', childEmail: '', initialAmount: '', sex: '' }); reload();
          }}>Open account</Action>
        </div>
      )}

      {kids && (
        <Table
          head={['Child', 'Age', 'Account', 'Balance', 'Child is 18 on', '']}
          rows={kids.map((k) => [
            k.childName, k.childAge, k.accountNo, toKina(k.balance), fmtDate(k.comingOfAge),
            <button className="ghost" onClick={() => setMedFor(k)}>Medical withdrawal request</button>,
          ])}
          empty="You have not opened an account for a child yet."
        />
      )}

      {medFor && (
        <div className="card form-grid">
          <h3 className="wide">Medical withdrawal for {medFor.childName}</h3>
          <p className="muted small wide">An administrator reviews every request. Describe the medical need and keep the hospital or clinic letter ready.</p>
          <Field label="Amount (K)"><input type="number" min="0" step="0.01" value={med.amount} onChange={(e) => setMed({ ...med, amount: e.target.value })} /></Field>
          <Field label="Medical need"><input value={med.reason} onChange={(e) => setMed({ ...med, reason: e.target.value })} /></Field>
          <Field label="Evidence (where the letter is)"><input value={med.evidenceNote} onChange={(e) => setMed({ ...med, evidenceNote: e.target.value })} /></Field>
          <Action onRun={async () => {
            await api(`/students/${medFor.id}/medical-requests`, { method: 'POST', body: { amount: toToea(med.amount), reason: med.reason, evidenceNote: med.evidenceNote } });
            setMedFor(null); setMed({ amount: '', reason: '', evidenceNote: '' }); alert('Request sent to the administrator.');
          }}>Send request</Action>
          <button className="ghost" onClick={() => setMedFor(null)}>Cancel</button>
        </div>
      )}
    </>
  );
}
