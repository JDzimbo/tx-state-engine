import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const rawUrl = process.env.DATABASE_URL;
if (!rawUrl) {
  throw new Error('DATABASE_URL is not set in .env');
}

const connectionString = rawUrl.replace(/\?sslmode=require$/, '');

export const pool = new Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 5,
  min: 0, // Allow idle connections to close, forcing new ones when needed
  idleTimeoutMillis: 5000, // Close idle clients quickly to avoid stale sockets
  connectionTimeoutMillis: 30000, // Fail fast if a connection can't be made
  keepAlive: true,
  keepAliveInitialDelayMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected Postgres pool error', err.message);
});

// Retry wrapper with exponential backoff for transient pooler timeouts
export async function query<T = any>(
  text: string,
  params?: any[],
  retries = 3
): Promise<T[]> {
  let lastErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await pool.query(text, params);
      return res.rows as T[];
    } catch (err: any) {
      lastErr = err;
      const isTransient =
        err.code === 'EAUTHTIMEOUT' ||
        err.code === 'ECONNRESET' ||
        err.code === 'ETIMEDOUT' ||
        err.code === '08006' || // connection_failure
        /timeout/i.test(err.message || '');
      
      if (!isTransient || attempt === retries) {
        throw err;
      }
      
      const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
      console.warn(`DB transient error (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}