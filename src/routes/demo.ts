import { Router } from 'express';
import path from 'path';
import { query } from '../db/client';
import { reconcileTransaction } from '../services/reconciliation';
import type { Transaction, TransactionEvent } from '../types';

export const demoRouter = Router();

// Fixed tenant used by the demo UI. In production this would be resolved
// from the API key, but the demo has no auth so it uses a known tenant.
const DEMO_TENANT_SLUG = 'demo-bank';

/**
 * Serve the demo UI at the root.
 */
demoRouter.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

/**
 * Helper: get or create the demo tenant.
 */
async function getDemoTenantId(): Promise<string> {
  const rows = await query<{ id: string }>(
    `INSERT INTO tenants (name, slug)
     VALUES ('Demo Bank', $1)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [DEMO_TENANT_SLUG]
  );
  return rows[0].id;
}

/**
 * GET /demo/transactions
 * List the 20 most recent transactions for the demo tenant.
 */
demoRouter.get('/demo/transactions', async (_req, res) => {
  try {
    const tenantId = await getDemoTenantId();
    const rows = await query<Transaction>(
      `SELECT id, status, status_reason, amount_minor, currency, direction, updated_at
         FROM transactions
        WHERE tenant_id = $1
        ORDER BY updated_at DESC
        LIMIT 20`,
      [tenantId]
    );
    res.json(rows);
  } catch (err: any) {
    console.error('GET /demo/transactions failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /demo/transactions/:id
 * Full detail for one transaction: events + reconciliation runs + cases.
 */
demoRouter.get('/demo/transactions/:id', async (req, res) => {
  try {
    const tenantId = await getDemoTenantId();

    const txRows = await query<Transaction>(
      `SELECT * FROM transactions WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, tenantId]
    );
    if (txRows.length === 0) {
      return res.status(404).json({ error: 'not found' });
    }

    const events = await query<TransactionEvent>(
      `SELECT source, event_type, occurred_at
         FROM transaction_events
        WHERE tenant_id = $1 AND transaction_id = $2
        ORDER BY occurred_at ASC`,
      [tenantId, req.params.id]
    );

    const reconciliations = await query(
      `SELECT resolved_status, reason, confidence, created_at
         FROM reconciliation_runs
        WHERE tenant_id = $1 AND transaction_id = $2
        ORDER BY created_at ASC`,
      [tenantId, req.params.id]
    );

    const cases = await query(
      `SELECT reference, status, opened_by, created_at
         FROM cases
        WHERE tenant_id = $1 AND transaction_id = $2`,
      [tenantId, req.params.id]
    );

    res.json({
      transaction: txRows[0],
      events,
      reconciliations,
      cases,
    });
  } catch (err: any) {
    console.error('GET /demo/transactions/:id failed:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /demo/scenario/:kind
 * Fire a scripted event sequence to demonstrate the engine.
 *   kind = 'happy'    → pending → settled
 *   kind = 'conflict' → bank says settled, ledger says reversed → inconsistent
 */
demoRouter.post('/demo/scenario/:kind', async (req, res) => {
  try {
    const kind = req.params.kind;
    const tenantId = await getDemoTenantId();

    // 1. Create a fresh transaction for this scenario
    const idemKey = `demo-${kind}-${Date.now()}`;
    const amount = kind === 'conflict' ? 250000 : 150000; // 2,500.00 or 1,500.00
    const currency = kind === 'conflict' ? 'USD' : 'NGN';

    const txRows = await query<{ id: string }>(
      `INSERT INTO transactions
         (tenant_id, idempotency_key, amount_minor, currency, direction, status)
       VALUES ($1, $2, $3, $4, 'debit', 'initiated')
       RETURNING id`,
      [tenantId, idemKey, amount, currency]
    );
    const transactionId = txRows[0].id;

    // 2. Insert the scenario's events
    const now = Date.now();
    const events =
      kind === 'conflict'
        ? [
            { source: 'bank_webhook', type: 'payment.settled', offset: 0 },
            { source: 'ledger', type: 'entry.reversed', offset: 3000 },
          ]
        : [
            { source: 'bank_webhook', type: 'payment.pending', offset: 0 },
            { source: 'bank_webhook', type: 'payment.settled', offset: 3000 },
          ];

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      await query(
        `INSERT INTO transaction_events
           (tenant_id, transaction_id, source, source_event_id, event_type, payload, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, source, source_event_id) DO NOTHING`,
        [
          tenantId,
          transactionId,
          e.source,
          `demo-evt-${transactionId}-${i}`,
          e.type,
          JSON.stringify({ demo: true, kind }),
          new Date(now + e.offset).toISOString(),
        ]
      );
    }

    // 3. Reconcile
    const result = await reconcileTransaction(tenantId, transactionId);

    res.status(201).json({
      transaction_id: transactionId,
      scenario: kind,
      state: {
        status: result.status,
        reason: result.reason,
        confidence: result.confidence,
      },
    });
  } catch (err: any) {
    console.error('POST /demo/scenario failed:', err);
    res.status(500).json({ error: err.message });
  }
});