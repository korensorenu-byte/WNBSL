import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.warn('[db] DATABASE_URL is not set; database calls will fail.');
}

export const pool = new pg.Pool({
  connectionString,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
  max: 10,
});

// BIGINT (toea) values are returned as strings by default; convert to safe numbers.
pg.types.setTypeParser(20, (v) => Number(v));
// DATE values stay as 'YYYY-MM-DD' strings so date comparisons are timezone-safe.
pg.types.setTypeParser(1082, (v) => v);

export const query = (text, params) => pool.query(text, params);

/** Run fn inside a transaction. fn receives a client with query(). */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
