import { query } from '../db/index.js';
import { DEFAULT_SETTINGS } from './settings.js';

// Settings are read on every money-moving request, so keep a short cache.
let cache = null;
let cachedAt = 0;
const TTL_MS = 30_000;

export async function getSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cachedAt < TTL_MS) return cache;
  const { rows } = await query('SELECT key, value FROM settings');
  const merged = { ...DEFAULT_SETTINGS };
  for (const r of rows) merged[r.key] = r.value;
  cache = merged;
  cachedAt = Date.now();
  return merged;
}

export function clearSettingsCache() {
  cache = null;
}
