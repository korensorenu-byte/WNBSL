import { useEffect, useMemo, useState } from 'react';
import { api, setToken, toToea } from './api.js';
import { navigate } from './router.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- Landing page ----------
export function Landing({ user }) {
  const [info, setInfo] = useState(null);
  useEffect(() => { api('/public/info').then(setInfo).catch(() => setInfo(null)); }, []);
  const name = info?.societyName || 'West New Britain Savings and Loans Society';

  return (
    <div className="landing">
      <header className="topbar">
        <div className="brand-inline"><span className="logo">WNBSLS</span><span className="small muted">{name}</span></div>
        <nav>
          <a href="#about">About</a>
          <a href="#services">Services</a>
          <a href="#calculator">Loan calculator</a>
          <a href="#join">Join</a>
          {user
            ? <button className="primary" onClick={() => navigate('/app')}>Open my portal</button>
            : <button className="ghost" onClick={() => navigate('/login')}>Sign in</button>}
        </nav>
      </header>

      <section className="hero">
        <div>
          <h1>Save together. Borrow wisely. Grow your community.</h1>
          <p className="lead">{name} helps members build savings, access fair loans and share in investment returns, with every transaction recorded and visible to the member.</p>
          <div className="form-row">
            <button className="primary big" onClick={() => document.getElementById('join')?.scrollIntoView({ behavior: 'smooth' })}>Request membership</button>
            {!user && <button className="ghost big" onClick={() => navigate('/login')}>Member or staff sign in</button>}
          </div>
        </div>
        {info && (
          <div className="card hero-facts">
            <div><div className="muted small">Savings interest</div><div className="stat-value">{info.savingsInterestRatePct}% p.a.</div></div>
            <div><div className="muted small">Loan interest</div><div className="stat-value">{info.loanInterestRatePct}% p.a.</div></div>
            <div><div className="muted small">Loan terms up to</div><div className="stat-value">{info.maxTermMonths} months</div></div>
          </div>
        )}
      </section>

      <section id="about" className="section">
        <h2>About the Society</h2>
        <p>The Society is a member-owned savings and loans society serving communities across West New Britain Province. Members pool their savings, lend to one another at fair rates and invest together for lasting returns.</p>
        <div className="grid3">
          <div className="card"><h3>Owned by members</h3><p className="muted">Every member holds share capital and has a say in how the Society is run.</p></div>
          <div className="card"><h3>Transparent</h3><p className="muted">Each deposit, withdrawal and repayment is recorded and visible in your own portal.</p></div>
          <div className="card"><h3>Local</h3><p className="muted">Money stays in the province to support small business, farming and family needs.</p></div>
        </div>
      </section>

      <section id="services" className="section">
        <h2>Services</h2>
        <div className="grid3">
          <div className="card"><h3>Savings</h3><p className="muted">Regular savings accounts that earn interest, credited monthly.</p></div>
          <div className="card"><h3>Loans</h3><p className="muted">Loans sized to your savings, with a clear repayment schedule from day one.</p></div>
          <div className="card"><h3>Investments</h3><p className="muted">Community investments, with returns shared with members.</p></div>
        </div>
      </section>

      {info?.products?.length > 0 && (
        <section id="products" className="section">
          <h2>Loan products</h2>
          <p className="muted">Compare what each loan costs. Members can apply for any product once they have an account.</p>
          <div className="grid3">
            {info.products.map((p) => (
              <div key={p.name} className="card">
                <h3>{p.name}</h3>
                <div className="stat-value">{p.annualRatePct}% <span className="muted small">p.a. {p.method === 'flat' ? 'flat' : 'reducing balance'}</span></div>
                <div className="small muted">Up to K{(p.maxAmount / 100).toLocaleString('en-US')} over {p.maxTermMonths} months</div>
                <p className="small">{p.description}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      <LoanCalculator info={info} />
      <JoinForm />

      <footer className="footer">
        <div>{name}</div>
        <div className="small muted">Kimbe, West New Britain Province, Papua New Guinea</div>
        <div className="small muted">Figures shown are estimates. Final terms are set out in your loan agreement.</div>
      </footer>
    </div>
  );
}

function LoanCalculator({ info }) {
  const [amount, setAmount] = useState(1000);
  const [months, setMonths] = useState(12);
  const rate = info?.loanInterestRatePct ?? 12;
  const maxTerm = info?.maxTermMonths ?? 36;
  const result = useMemo(() => {
    const P = Number(amount) || 0;
    const n = Math.max(1, Math.min(Number(months) || 1, maxTerm));
    const r = rate / 100 / 12;
    if (info?.loanMethod === 'flat') {
      const interest = P * (rate / 100) * (n / 12);
      const total = P + interest;
      return { monthly: total / n, interest, total };
    }
    const monthly = r === 0 ? P / n : (P * r) / (1 - Math.pow(1 + r, -n));
    const total = monthly * n;
    return { monthly, interest: total - P, total };
  }, [amount, months, rate, maxTerm, info?.loanMethod]);
  const kina = (v) => `K${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  return (
    <section id="calculator" className="section">
      <h2>Loan calculator</h2>
      <p className="muted">Estimate your monthly repayment. This is an illustration only and does not commit the Society to a loan.</p>
      <div className="card form-grid">
        <label className="field">Loan amount (K)<input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label className="field">Term (months)<input type="number" min="1" max={maxTerm} value={months} onChange={(e) => setMonths(e.target.value)} /></label>
        <div className="calc-result">
          <div className="muted small">Estimated monthly repayment</div>
          <div className="stat-value">{kina(result.monthly)}</div>
          <div className="small muted">Interest {kina(result.interest)} · Total repayable {kina(result.total)} · {rate}% p.a.</div>
        </div>
      </div>
    </section>
  );
}

function JoinForm() {
  const [f, setF] = useState({ fullName: '', email: '', phone: '', village: '', message: '' });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!EMAIL.test(f.email)) return setError('Please enter a valid email address.');
    setBusy(true);
    try {
      const r = await api('/public/membership-requests', { method: 'POST', body: f });
      setDone(r.message);
      setF({ fullName: '', email: '', phone: '', village: '', message: '' });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section id="join" className="section">
      <h2>Request membership</h2>
      <p className="muted">Tell us about yourself. An officer will review your request and email you. Once approved, you will receive an invitation to set up your member portal.</p>
      {done ? (
        <div className="card success">{done} We have sent a confirmation to your email.</div>
      ) : (
        <form className="card form-grid" onSubmit={submit}>
          <label className="field">Full name<input required value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></label>
          <label className="field">Email<input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
          <label className="field">Phone<input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
          <label className="field">Village / town<input value={f.village} onChange={(e) => setF({ ...f, village: e.target.value })} /></label>
          <label className="field wide">Message (optional)<textarea rows="3" value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} /></label>
          {error && <div className="error wide">{error}</div>}
          <div><button className="primary" disabled={busy}>{busy ? 'Sending…' : 'Submit request'}</button></div>
        </form>
      )}
    </section>
  );
}

// ---------- Sign in ----------
export function Login({ onLogin, notice }) {
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
        <button type="button" className="ghost small back" onClick={() => navigate('/')}>← Back to website</button>
        <h1>Sign in</h1>
        <p className="muted small">West New Britain Savings and Loans Society. Members and staff sign in here.</p>
        {notice && <div className="success small">{notice}</div>}
        <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" /></label>
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <button type="button" className="ghost small" onClick={() => navigate('/forgot')}>Forgot password?</button>
        <p className="muted small">New here? Use the invitation link sent to your email. Staff accounts are created by the administrator.</p>
      </form>
    </div>
  );
}

// ---------- Accept an invitation (staff or member) ----------
export function AcceptInvite({ token, onLogin }) {
  const [info, setInfo] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api(`/invitations/by-token/${encodeURIComponent(token)}`)
      .then((i) => { setInfo(i); setFullName(i.fullName || ''); })
      .catch((e) => setLoadError(e.message));
  }, [token]);

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (password !== confirm) return setError('The two passwords do not match.');
    setBusy(true);
    try {
      const r = await api('/invitations/accept', { method: 'POST', body: { token, password, fullName } });
      setToken(r.token);
      onLogin(r.user);
      navigate('/app', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <div className="login-wrap">
        <div className="card login">
          <h1>Invitation</h1>
          <div className="error">{loadError}</div>
          <button className="primary" onClick={() => navigate('/login')}>Go to sign in</button>
        </div>
      </div>
    );
  }
  if (!info) return <div className="center muted">Checking your invitation…</div>;

  const roleName = { admin: 'Administrator', officer: 'Loan Officer', cashier: 'Cashier', auditor: 'Auditor', member: 'Member' }[info.role];
  return (
    <div className="login-wrap">
      <form className="card login" onSubmit={submit}>
        <h1>Welcome</h1>
        <p>You have been invited to join as <b>{roleName}</b>{info.memberName ? <> for <b>{info.memberName}</b></> : null}.</p>
        <p className="muted small">Account email: <b>{info.email}</b></p>
        <label>Full name<input required value={fullName} onChange={(e) => setFullName(e.target.value)} /></label>
        <label>Choose a password (12+ characters)<input type="password" required minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></label>
        <label>Confirm password<input type="password" required minLength={12} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" /></label>
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={busy}>{busy ? 'Activating…' : 'Activate my account'}</button>
        <p className="muted small">This invitation expires on {new Date(info.expiresAt).toLocaleDateString('en-GB')}.</p>
      </form>
    </div>
  );
}

// ---------- Forgot password (all users) ----------
export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await api('/auth/forgot', { method: 'POST', body: { email } });
      setSent(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login-wrap">
      <form className="card login" onSubmit={submit}>
        <button type="button" className="ghost small back" onClick={() => navigate('/login')}>← Back to sign in</button>
        <h1>Forgot your password?</h1>
        {sent ? (
          <p>If an account exists for <b>{email}</b>, we have sent a reset link. The link works once and expires in one hour. Check your spam folder if it does not arrive.</p>
        ) : (
          <>
            <p className="muted small">Enter the email address on your account and we will send you a reset link.</p>
            <label>Email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" /></label>
            {error && <div className="error">{error}</div>}
            <button className="primary" disabled={busy}>{busy ? 'Sending…' : 'Send reset link'}</button>
          </>
        )}
      </form>
    </div>
  );
}

// ---------- Choose a new password from an emailed link ----------
export function ResetPassword({ token, onLogin }) {
  const [info, setInfo] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api(`/auth/reset/${encodeURIComponent(token)}`).then(setInfo).catch((e) => setLoadError(e.message));
  }, [token]);

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (password !== confirm) return setError('The two passwords do not match.');
    setBusy(true);
    try {
      const r = await api('/auth/reset', { method: 'POST', body: { token, password } });
      setToken(r.token);
      onLogin(r.user);
      navigate('/app', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <div className="login-wrap">
        <div className="card login">
          <h1>Reset link</h1>
          <div className="error">{loadError}</div>
          <button className="primary" onClick={() => navigate('/forgot')}>Request a new link</button>
        </div>
      </div>
    );
  }
  if (!info) return <div className="center muted">Checking your link…</div>;
  return (
    <div className="login-wrap">
      <form className="card login" onSubmit={submit}>
        <h1>Choose a new password</h1>
        <p className="muted small">For {info.email}</p>
        <label>New password (12+ characters)<input type="password" required minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" /></label>
        <label>Confirm new password<input type="password" required minLength={12} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" /></label>
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save password and sign in'}</button>
      </form>
    </div>
  );
}
