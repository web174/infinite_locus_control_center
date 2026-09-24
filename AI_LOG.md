# AI Assistance Log
---

## Log Entry 1: Understanding Race Conditions & AbortController (Part A1)
- **Tool used**: Claude (AI coding assistant)
- **My prompt**: Asked for a concept-level explanation (not ready code) of why the search component had a race condition, and how `AbortController` and an `isSubscribed` flag solve it.
- **Accepted**: The explanation of out-of-order responses, and the reasoning that `AbortController` alone isn't sufficient — it causes an `AbortError` on the fetch promise, which the catch block must explicitly check for, and `isSubscribed` is needed as a backup guard for timing edge cases.
- **Rejected/changed**: None — used this to write my own explanation in my own words rather than copying provided code directly.
- **Verification**: Re-explained the concept back in my own words (runner/race analogy) and confirmed the two-part protection (AbortController + isSubscribed) rather than assuming one mechanism alone was enough.

---

## Log Entry 2: Architectural Decisions (Node.js, PostgreSQL + MongoDB, Tenant Context)
- **Tool used**: Claude (AI coding assistant)
- **My prompt**: Discussed my own reasoning for choosing Node.js + Express (matches React frontend, shared language) and PostgreSQL + MongoDB (ACID needs vs. flexible logging), and asked for help identifying the trade-offs I hadn't considered.
- **Accepted**: Trade-off framing (single-threaded event loop risk for Node.js; operational overhead of running two databases) to round out my own stated reasoning.
- **Rejected/changed**: Did not accept any decision I hadn't already made myself — the AI only helped structure and complete the trade-off analysis.
- **Verification**: Cross-checked the trade-offs against what I already knew about Node.js's single-threaded model and the operational reality of managing two DB engines.

---

## Log Entry 3: Incident Root-Cause Analysis (Part C)
- **Tool used**: Claude (AI coding assistant)
- **My prompt**: Provided the actual incident evidence from the assignment brief (request IDs `a91`/`b03`, key `k-778`, missing unique constraint on `idempotency_records`, the cache key change from `tenantId:status:page` to `status`) and asked for help structuring my own root-cause analysis into a formal incident report.
- **Accepted**: Report formatting/structure, and fix code consistent with concepts already covered in Part A (unique constraint, row locking, tenant-scoped cache key) — all of which I derived myself from the evidence before asking for formatting help.
- **Rejected/changed**: Did not accept any fabricated evidence or scenario details — all root causes are based on the actual log/schema facts provided in the assignment brief, which I analyzed first before involving the AI tool.
- **Verification**: Re-derived each root cause independently from the evidence (timestamps, schema columns, cache key strings) before asking the AI to help structure the write-up; confirmed the proposed SQL fixes match patterns already verified in Part A (A3's idempotency constraint, A5's row locking).

