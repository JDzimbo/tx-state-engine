import { pool } from '../src/db/client';

const TENANT_SLUG = 'demo-bank';
const TENANT_NAME = 'Demo Bank';
const IDEMPOTENCY_KEY = 'demo-tx-001';

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Upsert tenant
    const tenantRes = await client.query<{ id: string }>(
      `INSERT INTO tenants (name, slug)
       VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [TENANT_NAME, TENANT_SLUG]
    );
    const tenantId = tenantRes.rows[0].id;

    // 2. Upsert transaction (idempotent on tenant + idempotency_key)
    const txnRes = await client.query<{ id: string }>(
      `INSERT INTO transactions
         (tenant_id, idempotency_key, amount_minor, currency, direction, status)
       VALUES ($1, $2, $3, $4, 'debit', 'initiated')
       ON CONFLICT (tenant_id, idempotency_key) DO UPDATE
         SET updated_at = now()
       RETURNING id`,
      [tenantId, IDEMPOTENCY_KEY, 5000000, 'NGN']
    );
    const transactionId = txnRes.rows[0].id;

    await client.query('COMMIT');

    console.log('✅ Seeded');
    console.log('   TENANT_ID      =', tenantId);
    console.log('   TRANSACTION_ID =', transactionId);
    console.log('');
    console.log('   Copy these — you will use them for curl tests.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Seed failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();