// Minimal client-side router (no extra dependency). Public pages live at /, /login and
// /invite/:token; the signed-in area lives under /app/...
import { useEffect, useState } from 'react';

export function navigate(to, { replace = false } = {}) {
  if (window.location.pathname === to) return;
  if (replace) window.history.replaceState({}, '', to);
  else window.history.pushState({}, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function usePath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onChange = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onChange);
    return () => window.removeEventListener('popstate', onChange);
  }, []);
  return path;
}

export function Redirect({ to }) {
  useEffect(() => { navigate(to, { replace: true }); }, [to]);
  return null;
}
