import { Router } from 'express';
import { query } from '../db/client';
import { reconcileTransaction } from '../services/reconciliation';
import type { EventSource } from '../types';

export const eventsRouter = Router();

interface EventBody {
  transaction_id: string;
  source: EventSource;
  source_event_id: string;
  event_type: string;
  payload?: Record<string, unknown>;
  occurred_at: string; // ISO string
}

/**
 * POST /events
 * Ingest a raw transaction event. Idempotent on (source, source_event_id).
 * After insertion, triggers reconciliation for the affected transaction.
 */
eventsRouter.post('/events', async (req, res) => {
  try {
    const tenantId = req.header('x-tenant-id');
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const body = req.body as EventBody;
    const required = ['transaction_id', 'source', 'source_event_id', 'event_type', 'occurred_at'];
    for (const field of required) {
      if (!body[field as keyof EventBody]) {
        return res.status(400).json({ error: `missing field: ${field}` });
      }
    }

    // 1. Verify the transaction belongs to this tenant
    const txns = await query<{ id: string }>(
      `SELECT id FROM transactions WHERE id = $1 AND tenant_id = $2`,
      [body.transaction_id, tenantId]
    );
    if (txns.length === 0) {
      return res.status(404).json({ error: 'transaction not found for this tenant' });
    }

    // 2. Insert the event. ON CONFLICT means duplicate webhook → return existing.
    const inserted = await query<{ id: string }>(
      `INSERT INTO transaction_events
         (tenant_id, transaction_id, source, source_event_id, event_type, payload, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, source, source_event_id) DO NOTHING
       RETURNING id`,
      [
        tenantId,
        body.transaction_id,
        body.source,
        body.source_event_id,
        body.event_type,
        JSON.stringify(body.payload ?? {}),
        body.occurred_at,
      ]
    );

    const duplicate = inserted.length === 0;

    // 3. Reconcile the transaction
    const result = await reconcileTransaction(tenantId, body.transaction_id);

    return res.status(duplicate ? 200 : 201).json({
      duplicate,
      state: {
        status: result.status,
        reason: result.reason,
        confidence: result.confidence,
      },
    });
  } catch (err: any) {
    console.error('POST /events failed:', err);
    return res.status(500).json({ error: err.message });
  }
});