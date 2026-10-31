import jwt from 'jsonwebtoken';

const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32) {
  console.warn('[auth] JWT_SECRET should be set to at least 32 random characters.');
}

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, memberId: user.member_id ?? null },
    secret || 'dev-only-insecure-secret',
    { expiresIn: '8h' },
  );
}

export function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  try {
    req.user = jwt.verify(token, secret || 'dev-only-insecure-secret');
    next();
  } catch {
    res.status(401).json({ error: 'Session expired, please sign in again' });
  }
}

/** Allow only the listed roles. */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission for this action' });
    }
    next();
  };
}

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function errorHandler(err, req, res, _next) {
  // 22P02: malformed id (e.g. not a UUID) and 23514: a CHECK constraint, both caused by bad input.
  if (err.code === '22P02') return res.status(400).json({ error: 'Invalid identifier' });
  if (err.code === '23514') return res.status(400).json({ error: 'One of the values is outside the allowed range' });
  const status = err.status || (err instanceof RangeError ? 400 : 500);
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Unexpected server error' : err.message });
}
