import { useEffect, useState, useCallback } from 'react';
import { api, setToken, getToken, toKina } from './api.js';
import { MembersPage, SavingsPage, LoansPage, InvestmentsPage, AdminPage } from './pages.jsx';

const NAV = [
  { key: 'dashboard', label: 'Dashboard', roles: ['admin', 'officer', 'auditor', 'member'] },
  { key: 'members', label: 'Members', roles: ['admin', 'officer', 'auditor', 'member'] },
  { key: 'savings', label: 'Savings', roles: ['admin', 'officer', 'auditor', 'member'] },
  { key: 'loans', label: 'Loans', roles: ['admin', 'officer', 'auditor', 'member'] },
  { key: 'investments', label: 'Investments', roles: ['admin', 'officer', 'auditor'] },
  { key: 'admin', label: 'Settings & Users', roles: ['admin', 'auditor'] },
];

export default function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [page, setPage] = useState('dashboard');

  useEffect(() => {
    if (!getToken()) return setChecking(false);
    api('/auth/me')
      .then(setUser)
      .catch(() => setToken(null))
      .finally(() => setChecking(false));
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
  }, []);

  if (checking) return <div className="center muted">Loading…</div>;
  if (!user) return <Login onLogin={setUser} />;

  const items = NAV.filter((n) => n.roles.includes(user.role));
  const current = items.some((n) => n.key === page) ? page : 'dashboard';

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo">WNBSLS</span>
          <small>Savings · Loans · Investments</small>
        </div>
        <nav className="nav">
          {items.map((n) => (
            <button key={n.key} className={current === n.key ? 'active' : ''} onClick={() => setPage(n.key)}>
              {n.label}
            </button>
          ))}
        </nav>
        <div className="who">
          <div>{user.fullName}</div>
          <div className="muted small">{user.role}</div>
          <button className="ghost" onClick={logout}>Sign out</button>
        </div>
      </aside>
      <main className="content">
        {current === 'dashboard' && <Dashboard user={user} />}
        {current === 'members' && <MembersPage user={user} />}
        {current === 'savings' && <SavingsPage user={user} />}
        {current === 'loans' && <LoansPage user={user} />}
        {current === 'investments' && <InvestmentsPage user={user} />}
        {current === 'admin' && <AdminPage user={user} />}
      </main>
    </div>
  );
}

function Login({ onLogin }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api('/auth/login', { method: 'POST', body: { email, password } });
      setToken(r.token);
      onLogin(r.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="card login" onSubmit={submit}>
        <h1>WNBSLS</h1>
        <p className="muted">West New Britain Savings and Loans Society</p>
        <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" /></label>
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}

function Dashboard({ user }) {
  const [s, setS] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (user.role === 'member') return;
    api('/reports/summary').then(setS).catch((e) => setErr(e.message));
  }, [user.role]);

  if (user.role === 'member') {
    return (
      <>
        <h2>Welcome, {user.fullName}</h2>
        <p className="muted">Use the menu to view your savings, loans and share capital.</p>
      </>
    );
  }
  if (err) return <div className="error">{err}</div>;
  if (!s) return <div className="muted">Loading summary…</div>;

  return (
    <>
      <h2>Dashboard</h2>
      <div className="stats">
        <Stat label="Active members" value={`${s.members.active}`} sub={`of ${s.members.total} registered`} />
        <Stat label="Share capital" value={toKina(s.shareCapital)} />
        <Stat label="Savings balance" value={toKina(s.savingsBalance)} />
        <Stat label="Loans outstanding" value={toKina(s.loans.outstanding)} sub={`${s.loans.active} active loans`} />
        <Stat label="Overdue loans" value={`${s.loans.overdueLoans}`} sub={toKina(s.loans.overdueAmount)} tone={s.loans.overdueLoans ? 'warn' : ''} />
        <Stat label="Portfolio at risk" value={`${s.loans.parRatioPct}%`} sub="overdue ÷ outstanding" tone={s.loans.parRatioPct > 5 ? 'warn' : ''} />
        <Stat label="Pending applications" value={`${s.loans.pendingApplications}`} />
        <Stat label="Investments (active)" value={toKina(s.investments.activePrincipal)} sub={`returns ${toKina(s.investments.returnsReceived)}`} />
      </div>
    </>
  );
}

function Stat({ label, value, sub, tone }) {
  return (
    <div className={`card stat ${tone || ''}`}>
      <div className="muted small">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  );
}
