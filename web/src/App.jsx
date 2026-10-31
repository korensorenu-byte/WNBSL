import { useEffect, useState, useCallback } from 'react';
import { api, setToken, getToken, toKina } from './api.js';
import { navigate, usePath, Redirect } from './router.js';
import { Landing, Login, AcceptInvite, ForgotPassword, ResetPassword } from './public.jsx';
import { MembersPage, SavingsPage, LoansPage, InvestmentsPage, AdminPage } from './pages.jsx';
import { TeamPage, OfficerDeskPage, CashDeskPage, ProductsPanel, InvestmentProductsPanel, IntegrationKeysPanel } from './staff.jsx';
import { PortalHome, LoanMarket, MyLoans, MyInvestments, EarningsPage } from './portal.jsx';
import { OtherInvestments, ChildrenAccounts } from './portal2.jsx';

const ALL = ['admin', 'officer', 'cashier', 'auditor', 'member'];
const STAFF = ['admin', 'officer', 'cashier', 'auditor'];
// memberLabel: what a customer sees for the same screen.
const SECTIONS = [
  { key: 'home', label: 'Dashboard', memberLabel: 'Overview', roles: ALL },
  { key: 'market', label: 'Loan market', memberLabel: 'Loan market', roles: ['member'] },
  { key: 'cash', label: 'Cash desk', roles: ['admin', 'cashier'] },
  { key: 'officer', label: 'Officer desk', roles: ['admin', 'officer'] },
  { key: 'members', label: 'Members', memberLabel: 'My details', roles: [...STAFF, 'member'] },
  { key: 'savings', label: 'Savings', memberLabel: 'My savings', roles: ALL },
  { key: 'loans', label: 'Loans', memberLabel: 'My loans', roles: ALL },
  { key: 'myinvest', label: 'My loan investments', roles: ['member'] },
  { key: 'otherinvest', label: 'Other investments', roles: ['member'] },
  { key: 'children', label: "Children's accounts", roles: ['member'] },
  { key: 'earnings', label: 'Earnings & transfers', roles: ['member'] },
  { key: 'investments', label: 'Investments', roles: STAFF },
  { key: 'team', label: 'Team & invitations', roles: ['admin'] },
  { key: 'settings', label: 'Settings & audit', roles: ['admin', 'auditor'] },
];

export default function App() {
  const path = usePath();
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    if (!getToken()) return setChecking(false);
    api('/auth/me')
      .then(setUser)
      .catch(() => setToken(null))
      .finally(() => setChecking(false));
  }, []);

  const signOut = useCallback(() => {
    setToken(null);
    setUser(null);
    navigate('/', { replace: true });
  }, []);

  if (checking) return <div className="center muted">Loading…</div>;

  const invite = path.match(/^\/invite\/([^/]+)$/);
  if (invite) return <AcceptInvite token={decodeURIComponent(invite[1])} onLogin={setUser} />;
  const reset = path.match(/^\/reset\/([^/]+)$/);
  if (reset) return <ResetPassword token={decodeURIComponent(reset[1])} onLogin={setUser} />;
  if (path === '/forgot') return <ForgotPassword />;

  if (path === '/login') {
    if (user) return <Redirect to="/app" />;
    return <Login onLogin={setUser} />;
  }

  if (path === '/app' || path.startsWith('/app/')) {
    if (!user) return <Login onLogin={setUser} notice="Please sign in to continue." />;
    return <Shell user={user} path={path} onSignOut={signOut} />;
  }

  return <Landing user={user} />;
}

function Shell({ user, path, onSignOut }) {
  const isMember = user.role === 'member';
  const items = SECTIONS.filter((s) => s.roles.includes(user.role));
  const requested = path.replace(/^\/app\/?/, '').split('/')[0] || 'home';
  const current = items.some((s) => s.key === requested) ? requested : 'home';
  const label = (s) => (isMember && s.memberLabel ? s.memberLabel : s.label);

  if (requested !== current && path !== '/app') return <Redirect to="/app" />;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo">WNBSLS</span>
          <small>Savings · Loans · Investments</small>
        </div>
        <nav className="nav">
          {items.map((s) => (
            <button key={s.key} className={current === s.key ? 'active' : ''} onClick={() => navigate(s.key === 'home' ? '/app' : `/app/${s.key}`)}>
              {label(s)}
            </button>
          ))}
        </nav>
        <div className="who">
          <div>{user.fullName}</div>
          <div className="muted small">{roleName(user.role)}</div>
          <button className="ghost" onClick={() => navigate('/')}>Public website</button>
          <button className="ghost" onClick={onSignOut}>Sign out</button>
        </div>
      </aside>
      <main className="content">
        {current === 'home' && (isMember ? <PortalHome user={user} /> : <Dashboard user={user} />)}
        {current === 'market' && <LoanMarket user={user} />}
        {current === 'cash' && <CashDeskPage />}
        {current === 'officer' && <OfficerDeskPage user={user} />}
        {current === 'members' && <MembersPage user={user} />}
        {current === 'savings' && <SavingsPage user={user} />}
        {current === 'loans' && (isMember ? <MyLoans /> : <LoansPage user={user} />)}
        {current === 'myinvest' && <MyInvestments />}
        {current === 'otherinvest' && <OtherInvestments />}
        {current === 'children' && <ChildrenAccounts />}
        {current === 'earnings' && <EarningsPage />}
        {current === 'investments' && <InvestmentsPage user={user} />}
        {current === 'team' && <TeamPage user={user} />}
        {current === 'settings' && (
          <>
            <AdminPage user={user} />
            {user.role === 'admin' && (
              <>
                <ProductsPanel />
                <InvestmentProductsPanel />
                <IntegrationKeysPanel />
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}

const roleName = (r) => ({ admin: 'Administrator', officer: 'Loan Officer', cashier: 'Cashier', auditor: 'Auditor', member: 'Member' })[r] || r;

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
        <p className="muted">Use the menu to view your savings, loans and share capital. Your statements and loan schedules are shown there.</p>
      </>
    );
  }
  if (err) return <div className="error">{err}</div>;
  if (!s) return <div className="muted">Loading summary…</div>;

  const quick = {
    admin: ['Review membership requests', 'officer', 'Open the cash desk', 'cash'],
    officer: ['Review membership requests', 'officer', 'Go to members', 'members'],
    cashier: ['Open the cash desk', 'cash', 'Go to savings', 'savings'],
    auditor: ['View the audit trail', 'settings', 'Go to loans', 'loans'],
  }[user.role];

  return (
    <>
      <h2>Dashboard</h2>
      {quick && (
        <div className="form-row">
          <button className="primary" onClick={() => navigate(`/app/${quick[1]}`)}>{quick[0]}</button>
          <button className="ghost" onClick={() => navigate(`/app/${quick[3]}`)}>{quick[2]}</button>
        </div>
      )}
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
