// Thin API client. The token is kept in sessionStorage (cleared when the browser tab closes).
const TOKEN_KEY = 'wnbsls.token';

export const getToken = () => sessionStorage.getItem(TOKEN_KEY);
export const setToken = (t) => (t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY));

export async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && token) setToken(null);
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

// Money helpers: the server stores toea (integers); the UI shows and enters kina.
export const toKina = (toea) => {
  const n = Number(toea) || 0;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const k = Math.floor(abs / 100).toLocaleString('en-US');
  return `${sign}K${k}.${String(abs % 100).padStart(2, '0')}`;
};
export const toToea = (kina) => Math.round(Number(kina) * 100);
export const fmtDate = (d) => (d ? String(d).slice(0, 10) : '—');
