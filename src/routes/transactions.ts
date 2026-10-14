import { Router } from 'express';
import { query } from '../db/client';
import type { Transaction } from '../types';

export const transactionsRouter = Router();

/**
 * GET /transactions/:id/state
 * Returns the resolved state of a transaction for a tenant.
 */
transactionsRouter.get('/transactions/:id/state', async (req, res) => {
  try {
    const tenantId = req.header('x-tenant-id');
    if (!tenantId) {
      return res.status(400).json({ error: 'x-tenant-id header required' });
    }

    const rows = await query<Transaction>(
      `SELECT id, status, status_reason, expected_by, amount_minor, currency, direction, updated_at
         FROM transactions
        WHERE id = $1 AND tenant_id = $2`,
      [req.params.id, tenantId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'transaction not found' });
    }

    const t = rows[0];

    // Friendly, human-readable message based on the state
    const message = humanMessage(t);

    return res.json({
      transaction_id: t.id,
      status: t.status,
      reason: t.status_reason,
      message,
      expected_by: t.expected_by,
      amount: { minor: t.amount_minor, currency: t.currency },
      direction: t.direction,
      updated_at: t.updated_at,
    });
  } catch (err: any) {
    console.error('GET /transactions/:id/state failed:', err);
    return res.status(500).json({ error: err.message });
  }
});

function humanMessage(t: Transaction): string {
  switch (t.status) {
    case 'settled':
      return 'Sent. Your recipient will receive it.';
    case 'pending':
      return t.expected_by
        ? `Confirming with the bank. Expected by ${t.expected_by}. Do not resend.`
        : 'Confirming with the bank. Do not resend.';
    case 'failed':
      return 'This did not go through. Your money never left. You can try again.';
    case 'inconsistent':
      return 'We found a mismatch and opened a case. A human is on it.';
    case 'initiated':
      return 'Just started. Waiting for the first signal from the bank.';
    default:
      return 'Unknown state.';
  }
}