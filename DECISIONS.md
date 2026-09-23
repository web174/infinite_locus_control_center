# Architectural Trade-offs & Decisions
---

## 1. Runtime & Framework: Node.js + Express

**Decision**: Node.js with Express for the backend.

**Reasoning**: The frontend is built in React (JavaScript/TypeScript), so using Node.js on the backend keeps the whole stack in one language. This removes context-switching between languages, makes it easier to share types between frontend and backend, and async/await patterns for handling network calls and DB queries feel consistent end-to-end.

**Trade-off**: Node.js is single-threaded, so CPU-heavy computation (e.g. complex score aggregation across many attempts) can block the event loop if not handled carefully. To manage this, heavy logic is kept close to the database (via SQL aggregation) rather than looping over large datasets in application code.

---

## 2. Database Strategy: PostgreSQL (primary) + MongoDB (logging)

**Decision**: PostgreSQL for core relational data (students, attempts, idempotency records); MongoDB for append-only activity/audit logs.

**Reasoning**: Student records, attempt scores, and idempotency tracking all need strict consistency — two attempts submitted at the same time must not corrupt the aggregate score, and duplicate submissions must not create duplicate rows. This needs ACID guarantees and relational integrity, which PostgreSQL provides directly through transactions and unique constraints. Activity/event logs, on the other hand, are high-volume, semi-structured, and don't need relational integrity — MongoDB's flexible schema is a better fit and keeps this data from cluttering the core relational tables.

**Trade-off**: Running two database engines adds operational overhead — two things to deploy, monitor, and back up instead of one. This was accepted because the two workloads (strict transactional writes vs. high-volume flexible logging) genuinely have different requirements.

---

## 3. Server-Derived Tenant Context

**Decision**: Tenant ID is never trusted from the request body or query parameters for state-changing operations — it is derived only from the authenticated server session.

**Reasoning**: Trusting a client-supplied `tenantId` opens the door to mass assignment and cross-tenant data access (a client could simply change the value in their request). Deriving it from `req.session.tenantId` (or the verified JWT) closes that gap entirely, since it can't be forged by editing the request payload.

**Trade-off**: None significant — this is a straightforward security requirement with no real functional cost, just a discipline to enforce consistently across every endpoint.

---

## 4. Concurrency Strategy: Pessimistic Locking for Attempt Writes

**Decision**: `SELECT ... FOR UPDATE` on the student row during attempt submission, combined with a `version` counter for simpler profile patches (optimistic check).

**Reasoning**: Attempt submission involves a read-recompute-write sequence (insert attempt → recompute aggregate score → update student row), and under concurrent submissions this needs to happen as one atomic, ordered unit — an optimistic retry here would mean redoing the recompute anyway, so locking is more efficient for this specific path. Simple profile edits (e.g. name change) don't need this level of protection, so a lightweight version check is used there instead.

**Trade-off**: Row locks briefly block other writers to the same student row under high write concurrency — acceptable here since attempt submissions per student are not extremely frequent in practice.