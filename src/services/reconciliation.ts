import { query } from '../db/client';
import type {
  Transaction,
  TransactionEvent,
  TransactionStatus,
  ReconciliationResult,
  EventRule,
  EventSource,
  Confidence,
} from '../types';

// ============================================================
// RULES — what each source's event means, and how much to trust it
// ============================================================
const RULES: Record<EventSource, Record<string, EventRule>> = {
  bank_webhook: {
    'payment.settled': { status: 'settled', weight: 100 },
    'payment.failed': { status: 'failed', weight: 100 },
    'payment.pending': { status: 'pending', weight: 60 },
  },
  ledger: {
    'entry.posted': { status: 'settled', weight: 90 },
    'entry.reversed': { status: 'failed', weight: 90 },
    'entry.held': { status: 'pending', weight: 50 },
  },
  processor: {
    'charge.succeeded': { status: 'settled', weight: 80 },
    'charge.failed': { status: 'failed', weight: 80 },
    'charge.pending': { status: 'pending', weight: 40 },
  },
};

// ============================================================
// PUBLIC ENTRY POINT
// ============================================================
export async function reconcileTransaction(
  tenantId: string,
  transactionId: string
): Promise<ReconciliationResult> {
  const txns = await query<Transaction>(
    `SELECT * FROM transactions WHERE id = $1 AND tenant_id = $2`,
    [transactionId, tenantId]
  );
  if (txns.length === 0) {
    throw new Error('Transaction not found');
  }
  const txn = txns[0];

  const events = await query<TransactionEvent>(
    `SELECT * FROM transaction_events
     WHERE tenant_id = $1 AND transaction_id = $2
     ORDER BY occurred_at ASC`,
    [tenantId, transactionId]
  );

  const result = computeState(events);

  await persistResult(tenantId, txn, result);

  return result;
}

// ============================================================
// THE ALGORITHM — pure, no DB, easy to unit test
// ============================================================
export function computeState(events: TransactionEvent[]): ReconciliationResult {
  // No events yet — we genuinely don't know
  if (events.length === 0) {
    return {
      status: 'pending',
      reason: 'awaiting first event',
      confidence: 'low',
      evidence: [],
      open_case: false,
    };
  }

  // Map each event to a candidate status via RULES
  const candidates: { status: TransactionStatus; weight: number; event: TransactionEvent }[] = [];
  for (const event of events) {
    const sourceRules = RULES[event.source];
    if (!sourceRules) continue;
    const rule = sourceRules[event.event_type];
    if (!rule) continue;
    candidates.push({ status: rule.status, weight: rule.weight, event });
  }

  // No event matched a known rule — we're flying blind
  if (candidates.length === 0) {
    return {
      status: 'pending',
      reason: 'events received but none recognized',
      confidence: 'low',
      evidence: events,
      open_case: false,
    };
  }

  // Group candidates by the status they suggest
  const byStatus = new Map<TransactionStatus, typeof candidates>();
  for (const c of candidates) {
    const arr = byStatus.get(c.status) ?? [];
    arr.push(c);
    byStatus.set(c.status, arr);
  }

  // Only one distinct status proposed → agreed
  if (byStatus.size === 1) {
    const [status, group] = Array.from(byStatus.entries())[0];
    const best = group.reduce((a, b) => (a.weight >= b.weight ? a : b));
    return {
      status,
      reason: explainAgreement(best),
      confidence: confidenceFor(best.weight),
      evidence: group.map((c) => c.event),
      open_case: false,
    };
  }

  // Conflict — multiple statuses proposed
  return handleConflict(events, byStatus);
}

// ============================================================
// CONFLICT HANDLING
// ============================================================
function handleConflict(
  allEvents: TransactionEvent[],
  byStatus: Map<TransactionStatus, { status: TransactionStatus; weight: number; event: TransactionEvent }[]>
): ReconciliationResult {
  // Strongest claim per status group
  const strongest = new Map<TransactionStatus, { status: TransactionStatus; weight: number; event: TransactionEvent }>();
  for (const [status, group] of byStatus.entries()) {
    strongest.set(status, group.reduce((a, b) => (a.weight >= b.weight ? a : b)));
  }

  // Overall winner
  const winner = Array.from(strongest.values()).reduce((a, b) => (a.weight >= b.weight ? a : b));

  const terminal: TransactionStatus[] = ['settled', 'failed'];
  const opposingTerminal = Array.from(strongest.keys()).filter(
    (s) => terminal.includes(s) && s !== winner.status
  );

  // Rule 1: two sources give contradictory terminal answers → INCONSISTENT
  if (terminal.includes(winner.status) && opposingTerminal.length > 0) {
    return {
      status: 'inconsistent',
      reason: `sources disagree on final outcome: ${winner.status} vs ${opposingTerminal.join(', ')}`,
      confidence: 'low',
      evidence: allEvents,
      open_case: true,
    };
  }

  // Rule 2: winner is terminal, rest are just pending → terminal wins
  if (terminal.includes(winner.status)) {
    return {
      status: winner.status,
      reason: `terminal state from ${winner.event.source} overrides pending signals`,
      confidence: 'high',
      evidence: allEvents,
      open_case: false,
    };
  }

  // Rule 3: everything is pending, sources disagree on details
  return {
    status: 'pending',
    reason: 'multiple pending signals, no terminal state yet',
    confidence: 'medium',
    evidence: allEvents,
    open_case: false,
  };
}

// ============================================================
// HELPERS
// ============================================================
function explainAgreement(best: { event: TransactionEvent; status: TransactionStatus }): string {
  return `all sources agree: ${best.status} (via ${best.event.source}/${best.event.event_type})`;
}

function confidenceFor(weight: number): Confidence {
  if (weight >= 90) return 'high';
  if (weight >= 60) return 'medium';
  return 'low';
}

// ============================================================
// PERSISTENCE — update txn + log the run + open a case if needed
// ============================================================
async function persistResult(
  tenantId: string,
  txn: Transaction,
  result: ReconciliationResult
): Promise<void> {
  if (txn.status !== result.status) {
    await query(
      `UPDATE transactions
         SET status = $1, status_reason = $2, updated_at = now()
       WHERE id = $3 AND tenant_id = $4`,
      [result.status, result.reason, txn.id, tenantId]
    );

    await query(
      `INSERT INTO reconciliation_runs
         (tenant_id, transaction_id, resolved_status, reason, confidence, evidence)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [tenantId, txn.id, result.status, result.reason, result.confidence, JSON.stringify(result.evidence)]
    );

    await query(
      `INSERT INTO audit_log
         (tenant_id, actor_type, action, entity_type, entity_id, metadata)
       VALUES ($1, 'system', 'transaction.reconciled', 'transaction', $2, $3)`,
      [tenantId, txn.id, JSON.stringify({ from: txn.status, to: result.status, reason: result.reason })]
    );
  }

  if (result.open_case) {
    const existing = await query<{ id: string }>(
      `SELECT id FROM cases WHERE tenant_id = $1 AND transaction_id = $2 LIMIT 1`,
      [tenantId, txn.id]
    );
    if (existing.length === 0) {
      const ref = `CASE-${Date.now().toString().slice(-6)}`;
      await query(
        `INSERT INTO cases (tenant_id, transaction_id, reference, status, opened_by)
         VALUES ($1, $2, $3, 'open', 'system')`,
        [tenantId, txn.id, ref]
      );
    }
  }
}