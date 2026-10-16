
![Tests](https://img.shields.io/badge/tests-13%20passing-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)

# Transaction State Engine

A multi-tenant reconciliation engine that answers the one question every
fintech user has: **"Where is my money right now?"**

When a payment leaves a customer's account, no single system knows its
true state. The bank says "pending." The ledger says "posted." The
processor says "succeeded." They arrive out of order, sometimes twice,
sometimes never. The customer refreshes the app and sees nothing useful.

This engine ingests that messy stream, applies weighted rules, and resolves
a single trustworthy state — **settled, pending, failed, or inconsistent** —
with a reason, a confidence level, and an audit trail. When sources
contradict each other and cannot be safely resolved, it stops guessing,
flags the transaction, and opens a support case automatically.

**Live demo:** [tx-state-engine.onrender.com](https://tx-state-engine.onrender.com)

Click **Run Happy Path** to watch a clean settlement resolve to `settled`,
or **Trigger Conflict** to watch the engine detect contradictory sources
and auto-open a case. Click any transaction row to see its full event
history and the reconciliation decisions behind its current state.

---

## The Problem

Most fintech apps fail the same moment: the moment a user genuinely does
not know what happened to their money.

- The request times out. Did it succeed? Should I retry? Will I get charged twice?
- The app shows "Processing..." indefinitely, with no ETA and no reason.
- Support opens three dashboards, sees three different states, and can't tell the customer the truth.

The root cause isn't bad UI. It's that no single source of truth exists.
Every system has its own view, and nobody reconciles them.

---

## What It Does

**Ingests** messy events from banks, ledgers, and processors — including duplicates, out-of-order arrivals, and dropped webhooks.

**Resolves** a single state using weighted rules. Terminal signals (`settled`, `failed`) from trusted sources override pending ones. Conflicting terminal signals from different sources trigger an `inconsistent` state instead of a guess.

**Persists** every decision with evidence: what events it saw, why it reached the conclusion, and how confident it is.

**Escalates** to a human via auto-opened cases when the engine cannot safely resolve.

**Serves** the truth to two audiences:

- **Fintech apps** — via a public API (`GET /transactions/:id/state`)
- **Support agents** — via the audit trail and case queue

---

## Try It

```bash
# Install
npm install

# Configure (see .env.example)
cp .env.example .env

# Apply the schema (see docs/architecture.md for the SQL)

# Seed a demo tenant + transaction
npx ts-node scripts/seed.ts

# Run the simulator: 20 messy transactions, mixed scenarios
npx ts-node scripts/simulate.ts

# Start the server
npm run dev
```

Then hit the endpoints:

```bash
# Resolve a transaction's state
curl http://localhost:3000/transactions/<TX_ID>/state \
  -H "x-tenant-id: <TENANT_ID>"

# Send an event (idempotent)
curl -X POST http://localhost:3000/events \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: <TENANT_ID>" \
  -d '{
    "transaction_id": "<TX_ID>",
    "source": "bank_webhook",
    "source_event_id": "evt_001",
    "event_type": "payment.settled",
    "occurred_at": "2026-10-14T16:00:00Z"
  }'
```

### Simulator Output

```
📊 Summary

  settled         12
  inconsistent    4
  pending         4

  Duplicate events blocked: 4
  Cases auto-opened:        4
```

Every scenario — clean flows, duplicate webhooks, out-of-order arrivals,
contradicting sources, and stuck pendings — resolves to the correct state.

---

## Design Decisions

**Why weighted rules instead of timestamps?**
Timestamps tell you *when* a source spoke, not *how much to trust it*.
A bank's settlement webhook is more authoritative than a processor's
optimistic "succeeded" — even if it arrives later. Weights encode that trust.

**Why store evidence on every reconciliation run?**
Trust requires explanation. When a support agent or auditor asks *"why
did the system say this?"*, the engine can show the exact events that
led to the conclusion. Without evidence, the state is just an assertion.

**Why idempotency keys at the DB level, not the app level?**
Application-level deduplication breaks under concurrency. The unique
constraint on `(tenant_id, source, source_event_id)` is atomic and
survives race conditions. The app can be wrong; the database can't.

**Why `inconsistent` instead of picking a side?**
In fintech, being confidently wrong about money is worse than admitting
uncertainty. When two trusted sources give contradictory terminal
answers, the engine doesn't guess — it escalates.

---

## Architecture

```
              ┌─────────────────────────────┐
              │  POST /events               │
              │  (bank / ledger / processor)│
              └──────────────┬──────────────┘
                             │
                 dedup by (tenant, source, event_id)
                             │
                             ▼
              ┌─────────────────────────────┐
              │  reconciliation engine      │
              │                             │
              │  1. Load transaction        │
              │  2. Load events (ordered)   │
              │  3. Apply weighted rules    │
              │  4. Detect conflicts        │
              │  5. Resolve or escalate     │
              └──────────────┬──────────────┘
                             │
          ┌──────────────────┼──────────────────┐
          ▼                  ▼                  ▼
    transactions        reconciliation_runs   cases
    (current state)     (decision + evidence) (if unresolved)
                             │
                             ▼
                        audit_log
                        (immutable)
```

See `docs/architecture.md` for the schema and `docs/decisions.md` for deeper design notes.

---

## What's Not Here (Honest Limitations)

This is a working implementation, not production infrastructure.
Things a real deployment would add:

- **Authentication** — API keys exist in the schema, but requests currently trust the `x-tenant-id` header. Production needs signed requests or OAuth.
- **Rate limiting** — the schema has `rate_limit_rpm` but it isn't enforced yet.
- **Migrations** — schema is applied manually. Production needs versioned migrations.
- **Observability** — no tracing or metrics. Production needs OpenTelemetry.
- **The SSL workaround** — the DB client disables cert verification for local dev. Production should pin the CA certificate.

Naming these explicitly is part of the point. Knowing what's missing matters as much as knowing what's there.

---

## Competitive Context

The problem is real enough that venture-backed startups are attacking it.
[Cordant](https://cordant.io), which emerged from stealth in July 2026 with
$8M in seed funding, does something similar — normalizing transaction data
across systems, detecting contradictions, and producing audit-grade evidence.
That validates the thesis. This project is an independent implementation
focused on the specific case of contradictory terminal states across
payment rails.

---

## Built With

Node.js · TypeScript · Express · PostgreSQL (Supabase) · `pg`

---

## Author

**JDTech** — [github.com/jdzimbo](https://github.com/jdzimbo)

---

## License

MIT