import { pool, query } from '../src/db/client';
import { reconcileTransaction } from '../src/services/reconciliation';
import type { EventSource } from '../src/types';

const TENANT_SLUG = 'simulator-bank';
const TENANT_NAME = 'Simulator Bank';
const TX_COUNT = 20;

type EventSpec = {
  source: EventSource;
  event_type: string;
  occurredOffsetSec: number;
  duplicate?: boolean;
};

type TxScenario = {
  label: string;
  amount_minor: number;
  currency: string;
  events: EventSpec[];
  delayMs: number;
};

function buildScenario(i: number): TxScenario {
  const r = i % 5;
  const baseAmount = 100000 + i * 50000;

  switch (r) {
    case 0:
      return {
        label: 'clean-settled',
        amount_minor: baseAmount,
        currency: 'NGN',
        events: [
          { source: 'bank_webhook', event_type: 'payment.pending', occurredOffsetSec: 0 },
          { source: 'bank_webhook', event_type: 'payment.settled', occurredOffsetSec: 5 },
        ],
        delayMs: 100,
      };

    case 1:
      return {
        label: 'duplicate-webhook',
        amount_minor: baseAmount,
        currency: 'NGN',
        events: [
          { source: 'bank_webhook', event_type: 'payment.settled', occurredOffsetSec: 0 },
          { source: 'bank_webhook', event_type: 'payment.settled', occurredOffsetSec: 0, duplicate: true },
        ],
        delayMs: 100,
      };

    case 2:
      return {
        label: 'out-of-order',
        amount_minor: baseAmount,
        currency: 'NGN',
        events: [
          { source: 'bank_webhook', event_type: 'payment.settled', occurredOffsetSec: 10 },
          { source: 'bank_webhook', event_type: 'payment.pending', occurredOffsetSec: 0 },
        ],
        delayMs: 150,
      };

    case 3:
      return {
        label: 'conflict-inconsistent',
        amount_minor: baseAmount,
        currency: 'USD',
        events: [
          { source: 'bank_webhook', event_type: 'payment.settled', occurredOffsetSec: 0 },
          { source: 'ledger', event_type: 'entry.reversed', occurredOffsetSec: 3 },
        ],
        delayMs: 150,
      };

    case 4:
      return {
        label: 'stuck-pending',
        amount_minor: baseAmount,
        currency: 'NGN',
        events: [
          { source: 'processor', event_type: 'charge.pending', occurredOffsetSec: 0 },
        ],
        delayMs: 50,
      };
  }

  throw new Error('unreachable');
}

async function ensureTenant(): Promise<string> {
  const rows = await query<{ id: string }>(
    `INSERT INTO tenants (name, slug)
     VALUES ($1, $2)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [TENANT_NAME, TENANT_SLUG]
  );
  return rows[0].id;
}

async function createTransaction(
  tenantId: string,
  scenario: TxScenario,
  index: number
): Promise<string> {
  // Use a unique idempotency key per run so repeated simulator runs don't collide
  const idemKey = `sim-${Date.now()}-${index}`;
  const rows = await query<{ id: string }>(
    `INSERT INTO transactions
       (tenant_id, idempotency_key, amount_minor, currency, direction, status)
     VALUES ($1, $2, $3, $4, 'debit', 'initiated')
     RETURNING id`,
    [tenantId, idemKey, scenario.amount_minor, scenario.currency]
  );
  return rows[0].id;
}

/**
 * Insert a transaction event.
 *
 * The `source_event_id` is derived from (transaction index, LOGICAL event index,
 * source, event type). A duplicate event uses the same logical index as its
 * original so both produce the SAME `source_event_id` — the UNIQUE constraint
 * on (tenant_id, source, source_event_id) then blocks the duplicate.
 *
 * @returns true if the row was inserted, false if it was blocked as a duplicate
 */
async function insertEvent(
  tenantId: string,
  transactionId: string,
  spec: EventSpec,
  txIndex: number,
  eventIndex: number
): Promise<boolean> {
  // A duplicate uses the previous event's index, so it collides with the original
  const logicalIndex = spec.duplicate ? eventIndex - 1 : eventIndex;
  const sourceEventId = `sim-${txIndex}-evt-${logicalIndex}-${spec.source}-${spec.event_type}`;

  const occurredAt = new Date(Date.now() + spec.occurredOffsetSec * 1000).toISOString();

  const res = await query<{ id: string }>(
    `INSERT INTO transaction_events
       (tenant_id, transaction_id, source, source_event_id, event_type, payload, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, source, source_event_id) DO NOTHING
     RETURNING id`,
    [
      tenantId,
      transactionId,
      spec.source,
      sourceEventId,
      spec.event_type,
      JSON.stringify({ simulator: true }),
      occurredAt,
    ]
  );

  return res.length > 0;
}

async function runSimulation() {
  console.log('🎬 Starting simulation\n');

  const tenantId = await ensureTenant();
  console.log(`Tenant: ${tenantId} (${TENANT_SLUG})\n`);

  const results: { label: string; finalStatus: string; duplicates: number }[] = [];

  for (let i = 0; i < TX_COUNT; i++) {
    const scenario = buildScenario(i);
    const txId = await createTransaction(tenantId, scenario, i);

    let duplicates = 0;

    for (let j = 0; j < scenario.events.length; j++) {
      const event = scenario.events[j];
      const inserted = await insertEvent(tenantId, txId, event, i, j);
      if (!inserted) duplicates++;
      await new Promise((r) => setTimeout(r, 20));
    }

    const result = await reconcileTransaction(tenantId, txId);

    results.push({
      label: scenario.label,
      finalStatus: result.status,
      duplicates,
    });

    console.log(
      `  [${String(i + 1).padStart(2, '0')}] ${scenario.label.padEnd(22)} → ${result.status.padEnd(13)} (${result.confidence})`
    );

    await new Promise((r) => setTimeout(r, scenario.delayMs));
  }

  console.log('\n📊 Summary\n');
  const counts: Record<string, number> = {};
  let totalDuplicates = 0;
  for (const r of results) {
    counts[r.finalStatus] = (counts[r.finalStatus] || 0) + 1;
    totalDuplicates += r.duplicates;
  }

  for (const [status, count] of Object.entries(counts)) {
    console.log(`  ${status.padEnd(15)} ${count}`);
  }
  console.log(`\n  Duplicate events blocked: ${totalDuplicates}`);

  const caseRows = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM cases WHERE tenant_id = $1`,
    [tenantId]
  );
  console.log(`  Cases auto-opened:        ${caseRows[0].count}`);
}

runSimulation()
  .then(() => {
    console.log('\n✅ Simulation complete');
    return pool.end();
  })
  .catch((err) => {
    console.error('❌ Simulation failed:', err);
    return pool.end().then(() => process.exit(1));
  });