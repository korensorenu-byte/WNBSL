// Creates default settings and the first admin user. Safe to re-run.
// Usage: ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-strong-password' npm run seed
import bcrypt from 'bcryptjs';
import { pool } from './index.js';
import { DEFAULT_SETTINGS } from '../lib/settings.js';

async function run() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  try {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      await pool.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
        [key, JSON.stringify(value)],
      );
    }
    console.log('[seed] default settings in place');

    if (email && password) {
      if (password.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters');
      const hash = await bcrypt.hash(password, 12);
      await pool.query(
        `INSERT INTO users (email, full_name, password_hash, role)
         VALUES ($1, 'System Administrator', $2, 'admin')
         ON CONFLICT (email) DO NOTHING`,
        [email.toLowerCase(), hash],
      );
      console.log(`[seed] admin user ready: ${email}`);
    } else {
      console.log('[seed] ADMIN_EMAIL / ADMIN_PASSWORD not set; no admin user created');
    }
  } catch (err) {
    console.error('[seed] failed:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

run();
