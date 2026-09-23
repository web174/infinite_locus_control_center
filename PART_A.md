# Part A – My Solutions (Advanced Engineering Reasoning)

---

## A1. Fixing the React Search Hook (Race Conditions + Stale State)

When I first read this component, the thing that stood out immediately was: every time `query`, `page` or `category` changes, a new `fetch` fires — but nothing stops the *old* fetch. So if I type fast, an older (slower) response can land *after* a newer one and silently overwrite my screen with stale data. This is the classic "race condition in useEffect" problem.

Here's everything I found wrong with the original code:

1. **No cancellation of old requests** – changing `query`/`page`/`category` quickly leaves multiple requests running in parallel, and there's no guarantee they resolve in order.
2. **No protection against out-of-order responses** – without an abort signal or a "is this still the latest request" check, a slow earlier response can clobber a fast newer one.
3. **Setting state after the component has unmounted** – if the user navigates away before the promise resolves, `setState` still fires, which React warns about and which can also leak memory.
4. **`fetch` doesn't throw on HTTP errors** – people forget this a lot. A 404 or 500 response still resolves successfully in `fetch`, so `.then(r => r.json())` runs on an error page/body instead of failing properly.
5. **Old errors stick around** – `error` was never cleared when a *new* request started, so you'd see an old error message overlapping a loading spinner, which looks buggy to the user.

So my fix uses `AbortController` (to actually cancel the in-flight request) combined with an `isSubscribed` flag (to guard against post-unmount state updates), plus a status-based state object instead of three separate booleans, since that avoids "impossible" combinations like `loading: true, error: "..."` existing at once.

```typescript
import { useState, useEffect } from 'react';

interface Student {
  id: string;
  name: string;
  tenantId: string;
}

interface FetchStudentsParams {
  query: string;
  page: number;
  category: string;
}

interface FetchStudentsState {
  status: 'idle' | 'loading' | 'success' | 'error';
  rows: Student[];
  error: string | null;
}

export function useStudentSearch({ query, page, category }: FetchStudentsParams) {
  const [state, setState] = useState<FetchStudentsState>({
    status: 'idle',
    rows: [],
    error: null,
  });

  useEffect(() => {
    const controller = new AbortController();
    let isSubscribed = true; // guard against setting state after unmount

    // clear old errors the moment a new request starts
    setState((prev) => ({ ...prev, status: 'loading', error: null }));

    async function executeSearch() {
      try {
        const params = new URLSearchParams({ q: query, page: String(page), category });
        const response = await fetch(`/api/students?${params.toString()}`, {
          signal: controller.signal,
        });

        // fetch() won't throw on 4xx/5xx by itself, so I have to check manually
        if (!response.ok) {
          throw new Error(`Server returned HTTP status ${response.status}`);
        }

        const data = await response.json();

        if (isSubscribed) {
          setState({ status: 'success', rows: data.items ?? [], error: null });
        }
      } catch (err: any) {
        if (err.name === 'AbortError') return; // this just means a newer request cancelled us — not a real error
        if (isSubscribed) {
          setState({ status: 'error', rows: [], error: err.message || 'Failed to fetch student records' });
        }
      }
    }

    executeSearch();

    return () => {
      isSubscribed = false;
      controller.abort(); // cancels the previous request whenever deps change or component unmounts
    };
  }, [query, page, category]);

  return state;
}
```

**Note:** this only fixes the client. On the server side, this endpoint should still have rate limiting (per session/tenant, so nobody can hammer it) and input validation (max page size, sanitize the query string) — otherwise someone could still abuse it even with a "well-behaved" frontend.

---

## A2. Making Invalid States Unrepresentable (TypeScript)

The core idea here is: instead of having separate `isLoading`, `error`, `data` booleans/fields that can combine into nonsense states (e.g. loading = true *and* data present *and* error set, all at once — which technically shouldn't happen but the type system doesn't stop it), I model the whole thing as **one discriminated union**. That way TypeScript itself refuses to let you construct an impossible state.

```typescript
export interface StudentDetails {
  id: string;
  name: string;
  readinessStatus: string;
  version: number;
}

export type StudentDetailsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: StudentDetails; isRefreshing: boolean; refreshError: string | null }
  | { status: 'error'; error: string; studentId?: string };

export type StudentDetailsAction =
  | { type: 'FETCH_START' }
  | { type: 'FETCH_SUCCESS'; payload: StudentDetails }
  | { type: 'FETCH_FAILURE'; error: string; studentId?: string }
  | { type: 'REFRESH_START' }
  | { type: 'REFRESH_FAILURE'; error: string };

// if I ever add a new action and forget to handle it below, this throws a compile error, not a runtime bug
function assertNever(x: never): never {
  throw new Error(`Unhandled action type: ${JSON.stringify(x)}`);
}

export function studentDetailsReducer(
  state: StudentDetailsState,
  action: StudentDetailsAction
): StudentDetailsState {
  switch (action.type) {
    case 'FETCH_START':
      return { status: 'loading' };

    case 'FETCH_SUCCESS':
      return { status: 'success', data: action.payload, isRefreshing: false, refreshError: null };

    case 'FETCH_FAILURE':
      return { status: 'error', error: action.error, studentId: action.studentId };

    case 'REFRESH_START':
      // refreshing only makes sense once we already have data
      if (state.status !== 'success') return state;
      return { ...state, isRefreshing: true, refreshError: null };

    case 'REFRESH_FAILURE':
      if (state.status !== 'success') return state;
      return { ...state, isRefreshing: false, refreshError: action.error };

    default:
      return assertNever(action as never);
  }
}
```

**Why I kept the old data on a failed refresh:** this is basically "stale-while-revalidate" — if a background refresh fails while I already have `status: 'success'` data on screen, I don't want to wipe the UI and show a scary error page. I'd rather keep showing the last good data and just pop a small warning (`refreshError`) so the user isn't blocked from working.

---

## A3. Making Writes Idempotent + Handling Concurrent Edits

Two different problems live here, so I split the contract into two headers:

- **`Idempotency-Key` (UUIDv4)** on `POST /api/students/:id/attempts` — this protects against duplicate submissions (e.g. the user double-clicks submit, or a retry fires after a timeout).
- **`If-Match` (or a `version` field in the body)** on `PATCH /api/students/:id` — this protects against two people editing the same student record at the same time and one silently overwriting the other's change.

**What happens on the server, inside one DB transaction:**

1. Look up `idempotency_records` by `(tenant_id, idempotency_key)` — this pair has a UNIQUE constraint so two identical keys can never both succeed.
2. If a record already exists:
   - Same request body as before → just return the cached `200 OK` response again (don't redo the write).
   - Different body but same key → this means the key got reused for a *different* request, which is a client bug → return `409 Conflict`.
3. Otherwise, do the actual write: insert the attempt row, recompute the student's aggregate score, bump `version = version + 1`.
4. Save the response into `idempotency_records` before the transaction commits, so a retry later can find it.

---

## A4. SQL — Recomputing Weighted Score From Latest Attempts

The tricky part of this question is "latest attempt **per competency**" — not just the latest attempt overall. I used `DISTINCT ON` for that since it's the cleanest way to do it in Postgres (much simpler than a window function + filter here).

```sql
WITH latest_attempts AS (
    SELECT DISTINCT ON (a.student_id, a.competency)
        a.student_id,
        a.competency,
        a.score,
        a.created_at
    FROM student_attempts a
    ORDER BY a.student_id, a.competency, a.created_at DESC, a.id DESC
    -- ordering by id DESC as a tiebreaker in case two attempts share the exact same timestamp
),
weighted_scores AS (
    SELECT
        s.id AS student_id,
        s.current_score AS recorded_score,
        COALESCE(
            SUM(
                CASE
                    WHEN la.score IS NULL THEN 0
                    WHEN la.competency = 'frontend' THEN la.score * 0.30
                    WHEN la.competency = 'backend' THEN la.score * 0.30
                    WHEN la.competency = 'databases' THEN la.score * 0.25
                    WHEN la.competency = 'problem_solving' THEN la.score * 0.15
                    ELSE 0
                END
            ), 0
        ) AS calculated_score
    FROM students s
    LEFT JOIN latest_attempts la ON s.id = la.student_id
    GROUP BY s.id, s.current_score
)
SELECT student_id, recorded_score, calculated_score
FROM weighted_scores
WHERE ABS(recorded_score - calculated_score) > 0.001; -- small epsilon since these are floats
```

**Index I'd add:**
```sql
CREATE INDEX idx_attempts_student_comp_time
ON student_attempts(student_id, competency, created_at DESC, id DESC);
```
This matches exactly the `PARTITION`/`ORDER BY` pattern `DISTINCT ON` needs, so Postgres can skip-scan instead of sorting the whole table.

**Isolation level:** at the default `READ COMMITTED`, if another transaction inserts a new attempt *while* this query is running, I could read a half-consistent picture (phantom read). Bumping to `REPEATABLE READ` for this specific check locks the query to a single consistent snapshot, which matters here since we're comparing a recorded value against a freshly-calculated one.

---

## A5. Optimistic vs Pessimistic Locking — Which One and Why

| | Optimistic (version check on UPDATE) | Pessimistic (`SELECT ... FOR UPDATE`) |
|---|---|---|
| Locking cost | None until the actual write | Row stays locked for the whole transaction |
| Under heavy contention | Lots of failed retries | Requests just queue up in order |
| How it works | Checks `version` matches before writing | Physically blocks other transactions from touching that row |

I went with **pessimistic locking** for this specific use case (recording an attempt + updating aggregate score), because attempts are written fairly often and we genuinely need the read-recompute-write to happen as one atomic unit — retrying an optimistic failure here would mean recomputing the whole score again anyway, so the "lock-free" benefit doesn't really pay off.

```typescript
async function recordAttemptWithLock(client: PoolClient, studentId: string, tenantId: string, attemptData: AttemptInput) {
  await client.query('BEGIN');
  try {
    // lock the student row so nobody else can read/write it until we commit
    const studentRes = await client.query(
      'SELECT id, version FROM students WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
      [studentId, tenantId]
    );
    if (studentRes.rows.length === 0) throw new Error('Student not found');

    await client.query(
      'INSERT INTO student_attempts (id, student_id, tenant_id, competency, score) VALUES ($1, $2, $3, $4, $5)',
      [attemptData.id, studentId, tenantId, attemptData.competency, attemptData.score]
    );

    const newScore = await recomputeStudentScore(client, studentId);
    await client.query(
      'UPDATE students SET current_score = $1, version = version + 1 WHERE id = $2',
      [newScore, studentId]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}
```

---

## A6. MongoDB Aggregation — Tenant Health & Anomaly Signals

Goal: for each tenant, in the last 24 hours, get the validation failure rate, how many *distinct* assessments were completed, and the latency spread of successful attempts.

```javascript
db.activity_events.aggregate([
  {
    $match: {
      occurredAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    }
  },
  {
    $group: {
      _id: "$tenantId",
      totalRequests: { $sum: 1 },
      failedValidations: {
        $sum: { $cond: [{ $eq: ["$eventType", "VALIDATION_FAILED"] }, 1, 0] }
      },
      // addToSet naturally dedupes assessmentIds for me
      successfulAssessments: {
        $addToSet: {
          $cond: [{ $eq: ["$eventType", "ATTEMPT_SUCCESS"] }, "$assessmentId", null]
        }
      },
      latencies: {
        $push: {
          $cond: [{ $eq: ["$eventType", "ATTEMPT_SUCCESS"] }, "$metadata.durationMs", "$$REMOVE"]
        }
      }
    }
  },
  {
    $project: {
      tenantId: "$_id",
      validationFailureRate: { $divide: ["$failedValidations", "$totalRequests"] },
      uniqueSuccessfulAssessments: {
        $size: { $setDifference: ["$successfulAssessments", [null]] } // drop the null placeholder from failed events
      },
      sortedLatencies: { $sortArray: { input: "$latencies", sortBy: 1 } }
    }
  }
]);
```

**Indexes needed** so this doesn't do a full collection scan every time:
```javascript
db.activity_events.createIndex({ occurredAt: -1, tenantId: 1 });
db.activity_events.createIndex({ tenantId: 1, eventType: 1 });
```

**One thing I'd flag:** just counting documents here is a bit dangerous — if a client retries a request after a timeout (thinking it failed when it actually succeeded), we'd double-count that event. I'd want an idempotency key on the event itself before trusting these numbers for anything like billing.

---

## A7. Security Review — What I'd Flag in Code Review

Going through the sample endpoint, three things jumped out:

1. **Mass assignment** — spreading `req.body` straight into the update means a malicious client could send `{ evaluatorRole: "admin" }` or `{ tenantId: "someone-else" }` in the payload and the server would just... accept it. Never trust the full body shape.
2. **Cross-tenant tampering** — the code trusts a `tenantId` sent by the client instead of pulling it from the authenticated session. That means one tenant could potentially read/write another tenant's data just by changing a field in their request.
3. **Stored XSS** — the `notes` field gets rendered as raw HTML later. If a user can put `<script>` tags into notes, that script runs for anyone who later views that student's page.

**How I'd fix each one:**
- Validate the request body against an explicit allowlist schema (Zod/Pydantic) so unknown fields are stripped, not accepted.
- Always derive `tenantId` and `evaluatorRole` from the server-side session/JWT — never from anything the client sends.
- Escape/sanitize `notes` before rendering (or render as plain text and let the frontend handle formatting safely).

---

## A8. Testing Strategy — What Actually Needs Real Infra

For the readiness score logic, a plain unit test with fixed inputs isn't enough to catch edge cases, so I wrote a property-based test instead — it throws random combinations of scores at the function and checks an invariant holds every time, rather than me having to guess which specific numbers might break it.

```typescript
import fc from 'fast-check';

test('Readiness score invariant holds across arbitrary competency configurations', () => {
  fc.assert(
    fc.property(
      fc.float({ min: 0, max: 100 }),
      fc.float({ min: 0, max: 100 }),
      fc.float({ min: 0, max: 100 }),
      (fe, be, db) => {
        // if problem_solving is missing, status must be INCOMPLETE no matter how high the other 3 scores are
        const status = calculateReadinessStatus({ frontend: fe, backend: be, databases: db });
        return status === 'INCOMPLETE';
      }
    )
  );
});
```

**What I would NOT mock:** the actual Postgres database. Mocking the SQL driver hides real bugs — wrong isolation-level behaviour, actual constraint violations, transaction rollback timing — none of that shows up against a fake driver. For anything touching transactions (like A3/A5 above), the integration tests need to run against a real Postgres instance (a throwaway Docker container is fine).

---

## A9. Recovering From a Bad Force-Push + AI Review Checklist

**Recovery steps**, in order:

1. Find the last good commit before the force-push wiped it:
   ```bash
   git reflog
   ```
2. Check it out into a fresh, isolated branch (don't touch `main` directly yet):
   ```bash
   git checkout -b recovery/pre-ai-leak <safe-commit-hash>
   ```
3. Re-apply whatever legitimate fixes were made after that point, run the full test suite, then merge back into `main` once everything's verified clean.

**Before I'd approve any AI-generated change going forward, I'd want to see:**
- [x] A manual, line-by-line read confirming there's no client-controlled tenant override anywhere in the diff.
- [x] Full unit + integration suite passing (green, not partially skipped).
- [x] The AI interaction itself logged in `AI_LOG.md`, so there's a paper trail of what was generated vs. what was hand-written.