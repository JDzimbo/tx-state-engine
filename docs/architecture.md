# Architecture

The Transaction State Engine is built around three ideas:

1. **A single source of truth** — the `transactions` table holds the resolved state.
2. **An immutable evidence trail** — every decision is recorded with the events that led to it.
3. **Trust-weighted reconciliation** — not all sources are equal, and the engine knows that.

This document explains how those ideas map to actual tables, code, and data flow.

---

## Data Model

Eight tables. Each one has a purpose; none are decorative.

### `tenants`
The institution using the engine (a bank, neobank, or fintech).

| Column | Purpose |
|---|---|
| `id` | UUID primary key |
| `slug` | Human-readable unique identifier (`demo-bank`) |
| `status` | `active` \| `suspended` |

### `api_keys`
Credentials for server-to-server requests. Keys are **hashed**, never stored in plaintext.

| Column | Purpose |
|---|---|
| `key_hash` | SHA-256 of the actual key |
| `key_prefix` | Display-only prefix (`sk_live_bankA`) |
| `environment` | `live` \| `test` |
| `scopes` | Permissions array |
| `rate_limit_rpm` | Per-tenant throughput cap |
| `revoked_at` | Nullable; revocation without deletion |

### `users`
Support/ops agents who log into the dashboard.

| Column | Purpose |
|---|---|
| `role` | `agent` \| `admin` |
| `mfa_enabled` | 2FA flag |

### `transactions`
The heart of the system. One row per money movement.

| Column | Purpose |
|---|---|
| `tenant_id` | Isolation boundary — every query filters on this |
| `idempotency_key` | **Unique per tenant** — prevents double charges |
| `amount_minor` | `BIGINT` in minor units (kobo/cents) — never floats |
| `status` | `initiated` \| `pending` \| `settled` \| `failed` \| `inconsistent` |
| `status_reason` | Human-readable explanation of the current state |
| `expected_by` | ETA shown to the customer |

**The critical constraint:** `UNIQUE (tenant_id, idempotency_key)`. If a customer's app retries after a network drop, the second insert fails silently — the app receives the existing transaction instead of creating a duplicate.

### `transaction_events`
The raw, messy stream. Every webhook, ledger entry, and callback lands here as-is.

| Column | Purpose |
|---|---|
| `source` | `bank_webhook` \| `ledger` \| `processor` |
| `source_event_id` | The source's own event ID |
| `event_type` | e.g. `payment.settled`, `entry.reversed` |
| `payload` | Full raw JSON |
| `occurred_at` | When it happened **at the source** |
| `received_at` | When **we** heard about it |

**Why two timestamps:** events arrive out of order. `occurred_at` is the truth; `received_at` is just when we learned it. Sorting by `occurred_at` reconstructs reality.

**The critical constraint:** `UNIQUE (tenant_id, source, source_event_id)`. Webhooks get delivered twice all the time. This silently drops duplicates at the database level, before the app even sees them.

### `reconciliation_runs`
Every time the engine reaches a decision, it records what it concluded and why.

| Column | Purpose |
|---|---|
| `resolved_status` | The state the engine chose |
| `reason` | Human-readable explanation |
| `confidence` | `high` \| `medium` \| `low` |
| `evidence` | JSONB — the exact events used to decide |

**Why evidence:** when a support agent or auditor asks *"why did the system say this?"*, the answer is stored, not reconstructed.

### `audit_log`
Append-only. No `UPDATE`. No `DELETE`. Ever.

| Column | Purpose |
|---|---|
| `actor_type` | `api_key` \| `user` \| `system` |
| `action` | e.g. `transaction.reconciled` |
| `entity_id` | The affected row |
| `metadata` | JSONB — `{from, to, reason}` |

This is what makes the system **compliance-defensible**: every state change is timestamped, attributed, and immutable.

### `cases`
Human follow-up. Auto-opened when the engine can't safely resolve.

| Column | Purpose |
|---|---|
| `reference` | Human-facing ID (`CASE-101447`) |
| `status` | `open` \| `investigating` \| `resolved` |
| `opened_by` | `system` \| user id |

---

## Request Flow

### Ingesting an event: `POST /events`

```
1. Validate x-tenant-id header
2. Validate required body fields
3. Verify the transaction belongs to this tenant
4. INSERT INTO transaction_events ... ON CONFLICT DO NOTHING
   → duplicate flag = (inserted.length === 0)
5. reconcileTransaction(tenantId, transactionId)
6. Return { duplicate, state: { status, reason, confidence } }
```

Steps 4 and 6 are the ones that matter. Step 4 uses the database's atomic unique constraint to deduplicate — no application-level race conditions. Step 6 returns the freshly resolved state, so the caller always sees the current truth.

### Reading the state: `GET /transactions/:id/state`

```
1. Validate x-tenant-id header
2. SELECT ... FROM transactions WHERE id = $1 AND tenant_id = $2
3. Translate status → human message
4. Return { status, reason, message, expected_by, amount, direction }
```

The message is what the customer sees. It's plain language, chosen by state:

| Status | Message |
|---|---|
| `settled` | "Sent. Your recipient will receive it." |
| `pending` | "Confirming with the bank. Expected by {time}. Do not resend." |
| `failed` | "This did not go through. Your money never left. You can try again." |
| `inconsistent` | "We found a mismatch and opened a case. A human is on it." |

---

## The Reconciliation Algorithm

`computeState(events)` is a **pure function** — no database, no side effects. That makes it trivially testable and easy to reason about.

### Step 1 — Rules
Every `(source, event_type)` pair maps to a status and a weight:

```typescript
bank_webhook: {
  'payment.settled': { status: 'settled', weight: 100 },
  'payment.failed':  { status: 'failed',  weight: 100 },
  'payment.pending': { status: 'pending', weight: 60  },
}
```

Weights encode trust. A bank's settlement webhook (100) outranks a processor's optimistic "succeeded" (80). When they disagree, the higher weight wins.

### Step 2 — Map
Every event is mapped to a candidate via its rule. Unknown event types are ignored.

### Step 3 — Group
Candidates are grouped by the status they suggest. If all candidates agree, the highest-weighted one wins and we return with high confidence.

### Step 4 — Conflict
If multiple distinct statuses are proposed, `handleConflict` decides:

- **Rule 1:** two sources give contradictory **terminal** answers (`settled` vs `failed`) → `inconsistent`, open a case.
- **Rule 2:** one terminal answer, others pending → terminal wins (the others just haven't caught up).
- **Rule 3:** all pending but disagreeing on details → still `pending`, medium confidence.

### Step 5 — Persist
If the resolved status differs from the stored one:

- Update `transactions.status`
- Insert a `reconciliation_runs` row with evidence
- Insert an `audit_log` entry

If the result flags `open_case`, insert a `cases` row (idempotently — one case per transaction).

---

## Multi-Tenancy

Every table carries `tenant_id`. Every query filters on it. There is no path through the codebase that returns another tenant's data.

This isn't just good hygiene — it's what makes the system sellable to banks. A bank cannot embed infrastructure that shares a database with a competitor.

The schema enforces it structurally:

- All foreign keys cascade on `tenant_id`
- Unique constraints include `tenant_id` in the key
- Indexes lead with `tenant_id`

---

## What's Not in This Doc

- Migration strategy for schema changes
- Horizontal scaling (read replicas, connection pooling across instances)
- Observability instrumentation (traces, metrics, structured logs)
- The CA-pinning fix for the SSL workaround

Those live in `decisions.md` under "Production Considerations."