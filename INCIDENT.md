# Production Incident Investigation Report

**Incident ID**: OUTAGE-20260922-1012
**Impact Level**: P1 Critical (Duplicate Data, Score Corruption, Cross-Tenant Leak)
**Date/Time**: 2026-09-22, starting 10:12 UTC

---

## Executive Summary

Starting at 10:12 UTC, a transient spike in network latency caused three related but distinct failures: duplicate attempt records from single button clicks, an incorrect readiness score that briefly displayed a wrong intermediate value, and a cross-tenant data leak where one tenant's cached response was served to a different tenant.

---

## Root Cause Analysis

### 1. Duplicate Attempt Submissions

**Symptom**: A single click on "submit" produced two attempt records in the database.

**Evidence**: Two requests, `a91` and `b03`, were logged arriving at the same timestamp (10:12:01) carrying the identical idempotency key `k-778`.

**Root Cause**: The `idempotency_records` table had the columns `tenant_id`, `key`, `response_json`, and `created_at`, but **no unique constraint** across `(tenant_id, key)`. Because mobile network retries fired the same request twice in quick succession, both requests reached the "check if this key exists" step before either had actually committed a record — so both passed the check and both proceeded to insert an attempt, producing duplicate rows `id=991` and `id=992`.

**Why this matters**: Without a database-level uniqueness guarantee, an application-level "check then insert" is inherently racy — two concurrent requests can both pass the check before either writes.

---

### 2. Score Computation Glitch (78 → 84 → 81)

**Symptom**: The displayed readiness score changed from 78 to 84 and then settled at 81, even though only correct data was ultimately stored.

**Root Cause**: Readiness scores were recomputed by reading all of a student's attempts in **application code** and then writing the result back to `students.current_score`, with no row lock held across the read-recompute-write sequence. When two attempts were inserted at nearly the same time, two separate recompute-and-write operations ran concurrently. Because neither held a lock on the student row, their writes could interleave and complete out of order — the recompute that read fewer attempts happened to write *after* the recompute that read more attempts, so the score briefly showed an intermediate/incorrect value (84) before a later, correct recompute (81) overwrote it.

**Why this matters**: A read-then-write sequence spread across multiple concurrent requests, without locking, has no guarantee about which write "wins" last — the final state depends on timing, not on which value is actually correct.

---

### 3. Cross-Tenant Data Leak

**Symptom**: A user in Tenant A (`t-green`) received cached data belonging to Tenant B (`t-blue`).

**Evidence**: The cache key had been shortened from `tenantId:status:page` to just `status`. Logs show `tenant=t-green` requesting data and receiving a cache hit on `cacheKey=students:READY`, a key that had been populated moments earlier by `tenant=t-blue`.

**Root Cause**: The cache key no longer included the tenant identifier, so all tenants sharing the same `status` and `page` value collapsed onto a single shared cache entry. Whichever tenant's request populated the cache first, every other tenant requesting the same status/page combination received that tenant's cached (and therefore wrong) data.

**Why this matters**: A cache key must include every dimension that makes a response unique — here `tenantId` was silently dropped from the key while remaining implicit in the underlying query, creating a mismatch between what was cached and what was actually being served.

---

## Initial Containment Actions (first 15 minutes)

1. **Flush the cache** — cleared the shared cache cluster to immediately stop serving cross-tenant data, accepting a short-term cache-miss performance cost in exchange for correctness.
2. **Rate-limit the attempts endpoint** — temporarily throttled `POST /api/students/:id/attempts` per client to reduce the volume of retried duplicate requests while the root cause was being fixed.
3. **Force synchronous, locked recomputation** — disabled the concurrent/background recompute path so score updates happened one at a time under a row lock, eliminating the out-of-order write.

---

## Permanent Engineering Fixes

### 1. Database-level uniqueness on idempotency keys

```sql
ALTER TABLE idempotency_records
ADD CONSTRAINT idx_tenant_idempotency_unique
UNIQUE (tenant_id, key);
```
This makes the "check then insert" race impossible — the second concurrent insert with the same key is rejected by the database itself, rather than relying on an application-level check that can be beaten by timing.

### 2. Tenant-scoped cache keys

```typescript
const cacheKey = `tenant:${req.session.tenantId}:status:${status}:page:${page}`;
```
The tenant ID is included directly in the cache key (and derived from the server session, not the request body — consistent with the tenant-context decision in `DECISIONS.md`), so two tenants can never collide on the same cache entry.

### 3. Locked, transactional score recomputation

Score recomputation now happens inside the same transaction as the attempt insert, under `SELECT ... FOR UPDATE` on the student row (see `DECISIONS.md`, Concurrency Strategy), so concurrent submissions are serialized instead of racing.

### 4. Non-destructive data repair

To clean up the duplicate rows created during the outage window without risking loss of legitimate data, duplicates are identified by matching `(student_id, competency, created_at)` and only rows beyond the first (by `id`) are removed:

```sql
WITH ranked_attempts AS (
    SELECT
        id,
        student_id,
        competency,
        created_at,
        ROW_NUMBER() OVER (
            PARTITION BY student_id, competency, created_at
            ORDER BY id DESC
        ) AS rn
    FROM student_attempts
    WHERE created_at BETWEEN '2026-09-22 10:10:00+00' AND '2026-09-22 10:20:00+00'
)
DELETE FROM student_attempts
WHERE id IN (
    SELECT id FROM ranked_attempts WHERE rn > 1
);
```
This was run against a copy of the affected data first to confirm only true duplicates (same student, competency, and timestamp) were removed, and that the row with the highest `id` — the most recently inserted, which reflects the final committed state — was preserved in each group.

---

## Lessons Learned

- Idempotency must be enforced with a **database constraint**, not just an application-level check — timing races defeat check-then-act logic.
- Any read-recompute-write sequence that can run concurrently needs an explicit lock or transaction boundary; "it usually finishes fast" is not a correctness guarantee.
- Cache keys must be reviewed whenever they're changed — dropping a dimension (like `tenantId`) that seems redundant can silently merge data across unrelated requests.