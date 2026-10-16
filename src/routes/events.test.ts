import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, pool } from '../db/client';
import { reconcileTransaction } from '../services/reconciliation';

// This integration test requires a live DATABASE_URL.
// It creates a tenant + transaction, sends two identical events,
// and asserts that the second is deduplicated.

const TEST_TENANT_SLUG = `test-tenant-${Date.now()}`;

describe('event idempotency (integration)', () => {
  let tenantId: string;
  let transactionId: string;

  beforeAll(async () => {
    const t = await query<{ id: string }>(
      `INSERT INTO tenants (name, slug)
       VALUES ('Test Tenant', $1)
       RETURNING id`,
      [TEST_TENANT_SLUG]
    );
    tenantId = t[0].id;

    const tx = await query<{ id: string }>(
      `INSERT INTO transactions
         (tenant_id, idempotency_key, amount_minor, currency, direction, status)
       VALUES ($1, $2, 100000, 'NGN', 'debit', 'initiated')
       RETURNING id`,
      [tenantId, `test-idem-${Date.now()}`]
    );
    transactionId = tx[0].id;
  });

  afterAll(async () => {
    // Clean up
    await query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    await pool.end();
  });

  it('stores the first event and deduplicates the second', async () => {
    const sourceEventId = `evt-idem-${Date.now()}`;

    const first = await query<{ id: string }>(
      `INSERT INTO transaction_events
         (tenant_id, transaction_id, source, source_event_id, event_type, payload, occurred_at)
       VALUES ($1, $2, 'bank_webhook', $3, 'payment.settled', '{}', now())
       ON CONFLICT (tenant_id, source, source_event_id) DO NOTHING
       RETURNING id`,
      [tenantId, transactionId, sourceEventId]
    );

    const second = await query<{ id: string }>(
      `INSERT INTO transaction_events
         (tenant_id, transaction_id, source, source_event_id, event_type, payload, occurred_at)
       VALUES ($1, $2, 'bank_webhook', $3, 'payment.settled', '{}', now())
       ON CONFLICT (tenant_id, source, source_event_id) DO NOTHING
       RETURNING id`,
      [tenantId, transactionId, sourceEventId]
    );

    expect(first.length).toBe(1);   // inserted
    expect(second.length).toBe(0);  // deduplicated
  });

  it('resolves the transaction to settled after a settled event', async () => {
    const result = await reconcileTransaction(tenantId, transactionId);
    expect(result.status).toBe('settled');
    expect(result.confidence).toBe('high');
  });
});