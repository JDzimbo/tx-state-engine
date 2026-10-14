# Design Decisions

The interesting parts of a system aren't the tables — they're the *why*.
This document records the choices that could have gone another way, and the
reasoning behind each.

---

## Why weighted rules instead of timestamps?

**Alternative considered:** the "latest event wins" model.

**Rejected because:** timestamps tell you *when* a source spoke, not
*how much to trust it*. A bank's settlement webhook is more authoritative
than a processor's optimistic "succeeded" — even if the processor's signal
arrives later. If you trust the clock, you trust the noisiest system.

Weighted rules encode trust explicitly:

| Source | Event | Weight |
|---|---|---|
| bank_webhook | `payment.settled` | 100 |
| ledger | `entry.posted` | 90 |
| processor | `charge.succeeded` | 80 |

When sources conflict, the weight decides. And when both sides are high-weight
terminal states, the engine refuses to choose (see next section).

---

## Why `inconsistent` instead of picking a side?

**Alternative considered:** pick the highest-weighted source and move on.

**Rejected because:** in fintech, being **confidently wrong** about money is
worse than admitting uncertainty. If a bank says "settled" and the ledger
says "reversed," both are authoritative signals. Choosing one silently
means the other system's reality gets ignored — which is exactly how
customers get charged twice or receive money they shouldn't.

Instead, the engine:

1. Marks the transaction `inconsistent`
2. Records both signals in `reconciliation_runs.evidence`
3. Auto-opens a case with a reference number
4. Shows the customer a message that doesn't lie: *"We found a mismatch and opened a case."*

A human resolves it. That's not a failure of the engine — it's a
correctness guarantee.

---

## Why idempotency keys at the database level, not the application?

**Alternative considered:** check if the event exists before inserting.

**Rejected because:** application-level check-then-insert is not atomic.
Under concurrent requests (a bank firing the same webhook twice simultaneously),
both requests can pass the check and both can insert. The race condition
is real and hard to test for.

The database's `UNIQUE` constraint is atomic. Two concurrent inserts,
one wins, one fails. No race.

```sql
UNIQUE (tenant_id, source, source_event_id)
```

Every ingestion path goes through this constraint. It is the load-bearing
wall against duplicates — not the code above it.

---

## Why store `evidence` on every reconciliation run?

**Alternative considered:** recompute from events when someone asks.

**Rejected because:** recomputation gives you *today's* answer, not *the
answer the engine gave at the time*. If the rules change (a new source
added, a weight adjusted), you'd lose the ability to explain past decisions.

Storing evidence means:

- Support can answer "why did we say this?" with the exact inputs
- Auditors can verify the decision was correct given what was known
- Regressions are detectable — you can replay old decisions against new rules

The tradeoff is storage. `evidence` is JSONB and duplicates data from
`transaction_events`. For a project at this scale, that's a fair trade.
At very high volume, you'd store event IDs only and join.

---

## Why `amount_minor` as `BIGINT` instead of `NUMERIC` or `FLOAT`?

**Alternative considered:** store amounts as decimals.

**Rejected because:** floating-point arithmetic loses precision. `0.1 + 0.2`
is not `0.3` in IEEE 754. For a fintech system, "off by a fraction of a cent"
is a bug that compounds into real money.

The rule: **store money as integers in the smallest unit.** ₦50,000 is
`5000000` kobo. $12.34 is `1234` cents. The database does exact integer
arithmetic. Currency is stored separately.

---

## Why `occurred_at` AND `received_at`?

**Alternative considered:** just use `received_at`.

**Rejected because:** events arrive out of order. A webhook that "happened"
at 10:00:05 might arrive at 10:00:30, after a webhook that happened at
10:00:10. If you sort by `received_at`, you reconstruct the wrong timeline.

- `occurred_at` = when the source says it happened
- `received_at` = when we learned about it

The reconciliation engine sorts by `occurred_at`. The `received_at` field
exists for debugging: if two events have nearly the same `occurred_at`
but wildly different `received_at`, you know the network is the problem,
not the source.

---

## Why is there no ORM?

**Alternative considered:** Prisma, TypeORM, Drizzle.

**Rejected because:** for a small, stable schema, an ORM adds more
abstraction than it removes. The engine's core logic lives in
`reconciliation.ts`, which is pure TypeScript. The database access is
simple CRUD with a handful of unique constraints — the exact case where
raw SQL is clearer than generated queries.

The tradeoff: manual SQL is harder to refactor. For a project of this
scope, that's fine. In a larger codebase, an ORM or query builder would
earn its keep.

---

## Why verify each request's tenant via the `x-tenant-id` header?

**Alternative considered:** derive tenant from an API key lookup on every request.

**What was implemented:** the schema stores hashed API keys, but requests
currently trust the `x-tenant-id` header directly. This is a
**deliberate simplification** for the demo.

**Why this is not production-safe:** a header alone means anyone who knows
a valid tenant ID can read that tenant's data. Real authentication requires:

1. Client sends an API key (not the tenant ID)
2. Server hashes it and looks up the tenant
3. Server ignores any `x-tenant-id` header the client sends

The schema already supports this (see `api_keys`). The route middleware
to enforce it is the next step for production. It's listed in the README's
"What's Not Here" section.

---

## Why a single `reconcileTransaction()` entry point?

Every code path that needs to update a transaction's state goes through one
function. That means:

- All state changes are logged identically
- All evidence is captured identically
- All cases are opened identically

If state could be updated from multiple places, audit logs would drift,
and cases would get missed. A single choke point makes correctness a
structural property, not a discipline.

---

## The SSL workaround — why `rejectUnauthorized: false`?

Supabase's pooler presents a certificate chain signed by an intermediate
CA that Node.js doesn't trust by default. Two options:

**Option A** — disable cert verification (`rejectUnauthorized: false`)
**Option B** — pin the CA certificate explicitly

Option A is used here because it gets local development working without
shipping a CA file. **Option B is what production needs.** Pinning the CA:

1. Prevents man-in-the-middle attacks on the DB connection
2. Allows `rejectUnauthorized: true`, restoring full TLS guarantees
3. Is a 10-line change (fetch CA, load it, pass to `pg`)

This is called out explicitly in the README because it's a **known
shortcut**, not an oversight.

---

## Production Considerations

Beyond what's implemented, a real deployment needs:

### Authentication
Replace `x-tenant-id` header trust with hashed API keys and request
signing. Track usage in `api_keys.last_used_at` for rotation.

### Rate limiting
`api_keys.rate_limit_rpm` exists but isn't enforced. Production would
enforce per-tenant caps to prevent one tenant from starving others.

### Migrations
Schema is currently applied manually via the Supabase SQL editor. Production
needs versioned migrations (Prisma Migrate, Flyway, or Supabase CLI's
migration system) so schema changes are reviewable and reversible.

### Observability
No traces, metrics, or structured logs. Production would add:

- **Traces** — OpenTelemetry spans on `reconcileTransaction`
- **Metrics** — decision counts by status, conflict rate, latency percentiles
- **Logs** — structured JSON, correlated by transaction ID

### Archival
`transaction_events` grows unbounded. Production would partition by time
and archive old rows to cold storage.

### Multi-region
Tenants in different regions would need either regional databases or a
globally distributed Postgres (CockroachDB, Aurora Global). The current
setup assumes a single-region primary.

---

## What I'd Change If I Started Over

Honestly: not much. The core design held up through implementation.

The one thing I'd do differently is add **schema versioning from day one**.
Adding migrations later is always more work than starting with them — and
a fintech infra project should model that discipline even at small scale.

The one thing I'd add earlier: **unit tests for `computeState()`**. The
function is pure, so tests are trivial — but I wrote the simulator first,
which validates the system end-to-end, not the algorithm in isolation.
Both are valuable; tests would have caught the duplicate-detection bug
faster than the simulator did.