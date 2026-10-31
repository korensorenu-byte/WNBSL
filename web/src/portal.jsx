import { useEffect, useState } from 'react';
import { api, toKina, toToea, fmtDate } from './api.js';
import { useData, Action, Table, Field, Badge } from './pages.jsx';
import { navigate } from './router.js';

// Member portal: overview, loan market, my loans, my investments, earnings.

// ---------- Overview ----------
export function PortalHome({ user }) {
  const { data: s, error, reload } = useData('/portal/summary', []);
  if (error) return <div className="error">{error}</div>;
  if (!s) return <div className="muted">Loading your account…</div>;

  const loansOutstanding = s.loans.reduce((t, l) => t + l.outstanding, 0);
  const stillInvested = s.investments.reduce((t, i) => t + i.stillInvested, 0);
  const interestEarned = s.investments.reduce((t, i) => t + i.interestEarned, 0);
  const due = s.loans.filter((l) => l.nextDue).sort((a, b) => a.nextDue.dueDate.localeCompare(b.nextDue.dueDate));

  return (
    <>
      <h2>Welcome, {user.fullName}</h2>
      <div className="stats">
        <Tile label="Savings" value={toKina(s.savingsTotal)} />
        <Tile label="Share capital" value={toKina(s.shareCapital)} />
        <Tile label="Earnings held" value={toKina(s.earningsBalance)} />
        <Tile label="Loans outstanding" value={toKina(loansOutstanding)} tone={s.loans.some((l) => l.overdue > 0) ? 'warn' : ''} />
        <Tile label="Invested in loans" value={toKina(stillInvested)} sub="still to be returned" />
        <Tile label="Interest earned" value={toKina(interestEarned)} />
      </div>

      <div className="form-row">
        <button className="primary" onClick={() => navigate('/app/market')}>Browse loans</button>
        <button className="ghost" onClick={() => navigate('/app/loans')}>My loans</button>
        <button className="ghost" onClick={() => navigate('/app/earnings')}>Move my earnings</button>
      </div>

      {due.length > 0 && (
        <>
          <h3>Upcoming repayments</h3>
          <Table
            head={['Loan', 'Next due', 'Amount', 'Overdue']}
            rows={due.map((l) => [l.loanNo, fmtDate(l.nextDue.dueDate), toKina(l.nextDue.amount), l.overdue ? <span className="badge rejected">{toKina(l.overdue)}</span> : '—'])}
          />
        </>
      )}

      <h3>Interest from loans I fund</h3>
      <InterestSetting current={s.member.interestDestination} onSaved={reload} />

      <h3>Recent activity</h3>
      <Table
        head={['When', 'What', 'Amount', 'Note']}
        rows={s.recentActivity.map((a) => [
          new Date(a.at).toLocaleString('en-GB'), a.kind.replace(/^(Savings|Earnings) /, ''),
          `${a.amount < 0 ? '−' : '+'}${toKina(Math.abs(a.amount))}`, a.note || '—',
        ])}
        empty="No activity yet."
      />
    </>
  );
}

function Tile({ label, value, sub, tone }) {
  return (
    <div className={`card stat ${tone || ''}`}>
      <div className="muted small">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  );
}

function InterestSetting({ current, onSaved }) {
  const [value, setValue] = useState(current);
  useEffect(() => setValue(current), [current]);
  return (
    <div className="card">
      <p className="muted small">Choose where interest from the loans you fund should go.</p>
      <label className="radio"><input type="radio" name="dest" checked={value === 'savings'} onChange={() => setValue('savings')} /> Add to my savings automatically (recommended)</label>
      <label className="radio"><input type="radio" name="dest" checked={value === 'hold'} onChange={() => setValue('hold')} /> Hold it as earnings, and I will move it myself</label>
      {value !== current && (
        <div className="form-row">
          <Action onRun={async () => { await api('/portal/preferences', { method: 'PATCH', body: { interestDestination: value } }); onSaved(); }}>Save setting</Action>
        </div>
      )}
    </div>
  );
}

// ---------- Loan market: compare products, apply, compare and fund open loans ----------
export function LoanMarket({ user }) {
  const { data: products } = useData('/loan-products', []);
  const { data: market, error, reload } = useData('/marketplace/loans', []);
  const { data: s } = useData('/portal/summary', []);
  const [selected, setSelected] = useState([]);
  const [applyFor, setApplyFor] = useState(null);

  const toggle = (id) => setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= 3 ? cur : [...cur, id]));
  const compared = (market || []).filter((l) => selected.includes(l.id));

  return (
    <>
      <h2>Loan market</h2>
      <p className="muted small">Compare loan products and open loans, then either apply for a loan or fund one from your savings. Borrowers are shown anonymously.</p>

      <h3>Loan products</h3>
      {products && (
        <div className="grid3">
          {products.map((p) => (
            <div key={p.id} className="card">
              <h3>{p.name}</h3>
              <div className="stat-value">{p.annualRatePct}% <span className="muted small">p.a. {p.method === 'flat' ? 'flat' : 'reducing'}</span></div>
              <div className="small muted">Up to {toKina(p.maxAmount)} over {p.maxTermMonths} months</div>
              <p className="small">{p.description}</p>
              <button className="ghost" onClick={() => setApplyFor(p.id)}>Apply</button>
            </div>
          ))}
        </div>
      )}
      {applyFor && <ApplyForm products={products || []} initialProductId={applyFor} memberId={user.memberId} onDone={() => { setApplyFor(null); reload(); }} onCancel={() => setApplyFor(null)} />}

      <h3>Open loans to fund</h3>
      {error && <div className="error">{error}</div>}
      {market && (
        <div className="card table-wrap">
          <table>
            <thead><tr><th></th><th>Loan</th><th>Product</th><th>Borrower</th><th>Rate</th><th>Term</th><th>Funded</th><th>Still needed</th><th>First payment</th></tr></thead>
            <tbody>
              {market.length === 0 && <tr><td colSpan="9" className="muted">No loans are open for funding right now.</td></tr>}
              {market.map((l) => (
                <tr key={l.id}>
                  <td><input type="checkbox" disabled={!selected.includes(l.id) && selected.length >= 3} checked={selected.includes(l.id)} onChange={() => toggle(l.id)} /></td>
                  <td>{l.loanNo}{l.isOwnLoan && <span className="muted small"> (yours)</span>}</td>
                  <td>{l.productName || '—'}</td>
                  <td className="small">{l.borrowerArea}</td>
                  <td>{l.annualRatePct}%</td>
                  <td>{l.termMonths} mo</td>
                  <td><ProgressBar pct={l.percentFunded} /></td>
                  <td>{toKina(l.remaining)}</td>
                  <td>{toKina(l.firstMonthlyPayment)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">Select up to three loans to compare them side by side.</p>

      {compared.length > 0 && <Comparison loans={compared} />}
      {compared.length > 0 && (
        <FundPanel loans={compared} accounts={s?.accounts || []} onDone={reload} />
      )}
    </>
  );
}

function ProgressBar({ pct }) {
  return (
    <div className="progress" title={`${pct}% funded`}>
      <div style={{ width: `${Math.min(100, pct)}%` }} />
      <span>{pct}%</span>
    </div>
  );
}

function Comparison({ loans }) {
  const rows = [
    ['Loan', (l) => l.loanNo],
    ['Product', (l) => l.productName || '—'],
    ['Amount', (l) => toKina(l.principal)],
    ['Interest rate', (l) => `${l.annualRatePct}% p.a.`],
    ['Method', (l) => (l.method === 'flat' ? 'Flat rate' : 'Reducing balance')],
    ['Term', (l) => `${l.termMonths} months`],
    ['First monthly payment', (l) => toKina(l.firstMonthlyPayment)],
    ['Total interest over term', (l) => toKina(l.totalInterest)],
    ['Funded so far', (l) => `${l.percentFunded}%`],
    ['Still needed', (l) => toKina(l.remaining)],
  ];
  return (
    <>
      <h3>Compare</h3>
      <div className="card table-wrap">
        <table>
          <thead><tr><th></th>{loans.map((l) => <th key={l.id}>{l.loanNo}</th>)}</tr></thead>
          <tbody>
            {rows.map(([label, f]) => (
              <tr key={label}><td className="muted">{label}</td>{loans.map((l) => <td key={l.id}>{f(l)}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function FundPanel({ loans, accounts, onDone }) {
  const fundable = loans.filter((l) => !l.isOwnLoan);
  const [loanId, setLoanId] = useState('');
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const chosen = loans.find((l) => l.id === loanId) || fundable[0];

  useEffect(() => { if (!loanId && fundable[0]) setLoanId(fundable[0].id); }, [fundable.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!accountId && accounts[0]) setAccountId(accounts[0].id); }, [accounts.length]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!fundable.length) return <p className="muted small">You cannot fund your own loan. Choose another one.</p>;
  return (
    <div className="card">
      <h3>Fund a loan from savings</h3>
      <p className="muted small">The money leaves your savings now and is returned to you as the borrower repays, with your share of interest. You can fund part of a loan.</p>
      <div className="form-grid">
        <Field label="Loan">
          <select value={chosen?.id || ''} onChange={(e) => setLoanId(e.target.value)}>
            {fundable.map((l) => <option key={l.id} value={l.id}>{l.loanNo} · still needed {toKina(l.remaining)}</option>)}
          </select>
        </Field>
        <Field label="From savings account">
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {accounts.filter((a) => a.status === 'open').map((a) => <option key={a.id} value={a.id}>{a.accountNo} · {toKina(a.balance)}</option>)}
          </select>
        </Field>
        <Field label="Amount (K)">
          <input type="number" min="0" step="0.01" value={amount} placeholder={chosen ? String(chosen.remaining / 100) : ''} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Action onRun={async () => {
          await api(`/marketplace/loans/${chosen.id}/invest`, { method: 'POST', body: { amount: toToea(amount), savingsAccountId: accountId } });
          setAmount(''); onDone();
        }}>Fund this loan</Action>
      </div>
    </div>
  );
}

function ApplyForm({ products, initialProductId, memberId, onDone, onCancel }) {
  const [productId, setProductId] = useState(initialProductId || products[0]?.id || '');
  const [amount, setAmount] = useState('');
  const [term, setTerm] = useState(12);
  const [purpose, setPurpose] = useState('');
  const [elig, setElig] = useState(null);
  const product = products.find((p) => p.id === productId);

  useEffect(() => {
    if (!productId) return;
    api(`/loans/eligibility/${memberId}?productId=${productId}`).then(setElig).catch(() => setElig(null));
  }, [productId, memberId]);

  return (
    <div className="card">
      <h3>Apply for a loan</h3>
      {elig && (
        <p className="small muted">
          You can borrow up to <b>{toKina(elig.maxLoan)}</b> with {product?.name}, over up to {elig.maxTermMonths} months at {elig.annualRatePct}% p.a.
          Your savings and shares count toward this limit.
        </p>
      )}
      <div className="form-grid">
        <Field label="Product">
          <select value={productId} onChange={(e) => setProductId(e.target.value)}>
            {products.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.annualRatePct}%</option>)}
          </select>
        </Field>
        <Field label="Amount (K)"><input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Term (months)"><input type="number" min="1" max={elig?.maxTermMonths || 36} value={term} onChange={(e) => setTerm(e.target.value)} /></Field>
        <Field label="Purpose"><input value={purpose} onChange={(e) => setPurpose(e.target.value)} /></Field>
        <Action onRun={async () => {
          await api('/loans', { method: 'POST', body: { productId, amount: toToea(amount), termMonths: Number(term), purpose, memberId } });
          onDone();
        }}>Submit application</Action>
        <button className="ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// ---------- My loans: monitor, see schedule, repay from savings or earnings ----------
export function MyLoans() {
  const { data: s, error, reload } = useData('/portal/summary', []);
  const [openId, setOpenId] = useState(null);
  if (openId) return <MyLoanDetail id={openId} accounts={s?.accounts || []} earnings={s?.earningsBalance || 0} onBack={() => { setOpenId(null); reload(); }} />;
  if (error) return <div className="error">{error}</div>;
  if (!s) return <div className="muted">Loading…</div>;
  return (
    <>
      <div className="page-head">
        <h2>My loans</h2>
        <button className="primary" onClick={() => navigate('/app/market')}>Apply for a loan</button>
      </div>
      <Table
        head={['Loan', 'Product', 'Status', 'Amount', 'Outstanding', 'Next payment', 'Overdue', '']}
        rows={s.loans.map((l) => [
          l.loanNo, l.productName || '—', <Badge status={l.status} />, toKina(l.principal),
          l.status === 'disbursed' ? toKina(l.outstanding) : '—',
          l.nextDue ? `${fmtDate(l.nextDue.dueDate)} · ${toKina(l.nextDue.amount)}` : '—',
          l.overdue ? toKina(l.overdue) : '—',
          <button className="ghost" onClick={() => setOpenId(l.id)}>Open</button>,
        ])}
        empty="You have not applied for any loans yet."
      />
      {s.loans.some((l) => l.status === 'approved') && (
        <p className="muted small">Approved loans are waiting to be funded by other members. They are paid out once fully funded.</p>
      )}
    </>
  );
}

function MyLoanDetail({ id, accounts, earnings, onBack }) {
  const { data: l, error, reload } = useData(`/loans/${id}`, [id]);
  const [source, setSource] = useState('savings');
  const [accountId, setAccountId] = useState('');
  const [amount, setAmount] = useState('');
  useEffect(() => { if (!accountId && accounts[0]) setAccountId(accounts[0].id); }, [accounts.length]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <div className="error">{error}</div>;
  if (!l) return <div className="muted">Loading…</div>;

  return (
    <>
      <button className="ghost" onClick={onBack}>← Back to my loans</button>
      <h2>{l.loanNo} <Badge status={l.status} /></h2>
      <div className="stats">
        <div className="card stat"><div className="muted small">Borrowed</div><div className="stat-value">{toKina(l.principal)}</div></div>
        <div className="card stat"><div className="muted small">Still to repay</div><div className="stat-value">{toKina(l.outstanding || 0)}</div></div>
        <div className="card stat"><div className="muted small">Rate</div><div className="stat-value small">{l.annualRatePct}% · {l.termMonths} months</div></div>
        <div className="card stat"><div className="muted small">Funded by</div><div className="stat-value small">{l.investorCount} member{l.investorCount === 1 ? '' : 's'}</div></div>
      </div>

      {l.status === 'disbursed' && (
        <div className="card form-grid">
          <Field label="Pay from">
            <select value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="savings">My savings</option>
              <option value="earnings">My held earnings ({toKina(earnings)})</option>
            </select>
          </Field>
          {source === 'savings' && (
            <Field label="Savings account">
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
                {accounts.filter((a) => a.status === 'open').map((a) => <option key={a.id} value={a.id}>{a.accountNo} · {toKina(a.balance)}</option>)}
              </select>
            </Field>
          )}
          <Field label="Amount (K)"><input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Action onRun={async () => {
            const body = { source, amount: toToea(amount) };
            if (source === 'savings') body.accountId = accountId;
            const r = await api(`/portal/loans/${id}/repay`, { method: 'POST', body });
            setAmount('');
            alert(`Paid ${toKina(r.applied)}. Outstanding ${toKina(r.outstanding)}${r.closed ? ' — loan cleared.' : '.'}`);
            reload();
          }}>Make repayment</Action>
        </div>
      )}

      <h3>Repayment schedule</h3>
      <Table
        head={['#', 'Due', 'Principal', 'Interest', 'Paid', 'Left to pay']}
        rows={(l.installments || []).map((i) => {
          const due = i.principalDue + i.interestDue;
          const paid = i.principalPaid + i.interestPaid;
          const late = paid < due && i.dueDate < new Date().toISOString().slice(0, 10);
          return [i.period, <span className={late ? 'badge rejected' : ''}>{fmtDate(i.dueDate)}</span>, toKina(i.principalDue), toKina(i.interestDue), toKina(paid), toKina(due - paid)];
        })}
        empty="The schedule appears once the loan is paid out."
      />
      <h3>Repayments made</h3>
      <Table head={['Date', 'Amount', 'Paid from']} rows={(l.repayments || []).map((r) => [fmtDate(r.paidOn), toKina(r.amount), r.source === 'cash' ? 'Cash desk' : r.source === 'savings' ? 'Savings' : 'Earnings'])} empty="No repayments yet." />
    </>
  );
}

// ---------- My investments ----------
export function MyInvestments() {
  const { data: s, error } = useData('/portal/summary', []);
  if (error) return <div className="error">{error}</div>;
  if (!s) return <div className="muted">Loading…</div>;
  const invested = s.investments.reduce((t, i) => t + i.amount, 0);
  const returned = s.investments.reduce((t, i) => t + i.returned, 0);
  const interest = s.investments.reduce((t, i) => t + i.interestEarned, 0);
  return (
    <>
      <h2>My investments in loans</h2>
      <div className="stats">
        <div className="card stat"><div className="muted small">Total committed</div><div className="stat-value">{toKina(invested)}</div></div>
        <div className="card stat"><div className="muted small">Capital returned</div><div className="stat-value">{toKina(returned)}</div></div>
        <div className="card stat"><div className="muted small">Interest earned</div><div className="stat-value">{toKina(interest)}</div></div>
      </div>
      <Table
        head={['Loan', 'Product', 'Stage', 'Committed', 'Capital returned', 'Interest earned', 'Still invested', 'Date']}
        rows={s.investments.map((i) => [
          i.loanNo, i.productName || '—', i.stage, toKina(i.amount), toKina(i.returned), toKina(i.interestEarned), toKina(i.stillInvested), fmtDate(i.investedOn),
        ])}
        empty="You have not funded any loans yet. Visit the Loan market to get started."
      />
    </>
  );
}

// ---------- Earnings: move held interest to savings or repay a loan ----------
export function EarningsPage() {
  const { data: s, error, reload } = useData('/portal/summary', []);
  const [to, setTo] = useState('savings');
  const [amount, setAmount] = useState('');
  const [accountId, setAccountId] = useState('');
  const [loanId, setLoanId] = useState('');
  useEffect(() => { if (s && !accountId && s.accounts[0]) setAccountId(s.accounts[0].id); }, [s]); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return <div className="error">{error}</div>;
  if (!s) return <div className="muted">Loading…</div>;

  const openLoans = s.loans.filter((l) => l.status === 'disbursed' && l.outstanding > 0);
  const earningLines = s.recentActivity.filter((a) => a.kind.startsWith('Earnings'));
  return (
    <>
      <h2>Earnings and transfers</h2>
      <div className="stats">
        <div className="card stat"><div className="muted small">Held earnings</div><div className="stat-value">{toKina(s.earningsBalance)}</div></div>
        <div className="card stat"><div className="muted small">Interest goes to</div><div className="stat-value small">{s.member.interestDestination === 'hold' ? 'Held as earnings' : 'My savings (automatic)'}</div></div>
      </div>
      <InterestSetting current={s.member.interestDestination} onSaved={reload} />

      <div className="card form-grid">
        <Field label="Move earnings to">
          <select value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="savings">My savings</option>
            <option value="loan" disabled={!openLoans.length}>Repay a loan</option>
          </select>
        </Field>
        {to === 'savings' ? (
          <Field label="Savings account">
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {s.accounts.filter((a) => a.status === 'open').map((a) => <option key={a.id} value={a.id}>{a.accountNo} · {toKina(a.balance)}</option>)}
            </select>
          </Field>
        ) : (
          <Field label="Loan">
            <select value={loanId} onChange={(e) => setLoanId(e.target.value)}>
              <option value="">Choose a loan…</option>
              {openLoans.map((l) => <option key={l.id} value={l.id}>{l.loanNo} · owing {toKina(l.outstanding)}</option>)}
            </select>
          </Field>
        )}
        <Field label="Amount (K)"><input type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Action onRun={async () => {
          const body = { amount: toToea(amount), to: to === 'loan' ? 'loan' : 'savings' };
          if (to === 'savings') body.accountId = accountId; else body.loanId = loanId;
          const r = await api('/portal/earnings/transfer', { method: 'POST', body });
          setAmount('');
          alert(r.to === 'loan' ? `Repaid ${toKina(r.amount)}. Outstanding ${toKina(r.outstanding)}.` : `Moved ${toKina(r.amount)} to your savings.`);
          reload();
        }}>Transfer</Action>
      </div>

      <h3>Earnings history</h3>
      <Table
        head={['When', 'Movement', 'Amount', 'Note']}
        rows={earningLines.map((a) => [new Date(a.at).toLocaleString('en-GB'), a.kind.replace('Earnings ', ''), `${a.amount < 0 ? '−' : '+'}${toKina(Math.abs(a.amount))}`, a.note || '—'])}
        empty="No earnings yet."
      />
    </>
  );
}

