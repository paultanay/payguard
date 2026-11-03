# PayGuard — Security Tests

## Running All Tests

```bash
cd packages/backend
npx vitest run --reporter=verbose
```

**Expected output: 62 tests passing, 0 failing**

Last verified: 2026-11-02, Node.js v26.10.0

---

## Test Suite Breakdown

### Unit Tests

#### `tests/unit/crypto.test.ts` (10 tests)

| Test | Security Invariant |
|---|---|
| SHA-256 consistent output | Deterministic hashing |
| SHA-256 differs for different inputs | Collision sensitivity |
| SHA-256 produces 64-char hex | Correct format |
| canonicalJson sorts keys deterministically | Canonical serialization |
| Nested objects sorted | Deep canonical form |
| Different values → different hash | Tamper sensitivity |
| Tampered amount changes canonical hash | **Invariant 4**: Modified signed intent rejected |
| Ed25519 sign + verify round-trip | **Invariant 1**: Signature validity |
| Signature fails with wrong key | Key binding |
| Signature fails with tampered message | **Invariant 4**: Tamper detection |

```bash
npx vitest run tests/unit/crypto.test.ts
```

---

#### `tests/unit/policy.test.ts` (15 tests)

| Test | Security Invariant |
|---|---|
| Creates policy with correct defaults | Policy model correctness |
| Rejects negative amount | Input validation |
| Denies when policy not found | **Invariant 1**: No payment without valid policy |
| Denies when agent ID mismatch | Agent binding |
| Denies when amount exceeds per-transaction limit | Spend limit enforcement |
| Denies when payee not in allowed list | Payee restriction |
| Denies when currency mismatches | Currency binding |
| Denies when operation not allowed | Operation restriction |
| Denies when policy is revoked | **Invariant 17**: Revoked policy safe failure |
| Denies when budget is zero | Budget exhaustion |
| Allows valid request within policy | ALLOW path |
| REQUIRE_APPROVAL when policy requires it | Approval workflow |
| computePeriodKey: daily | Period calculation |
| computePeriodKey: monthly | Period calculation |
| computePeriodKey: total | Period calculation |

```bash
npx vitest run tests/unit/policy.test.ts
```

---

#### `tests/unit/budget.test.ts` (9 tests)

| Test | Security Invariant |
|---|---|
| Reserves budget atomically | **Invariant 7**: Atomic reservation |
| Fails when amount exceeds remaining budget | **Invariant 7**: Budget enforcement |
| Two sequential reservations within budget | Normal flow |
| Third reservation fails when budget exhausted | **Invariant 7**: Exhaustion enforcement |
| Releasing a reservation restores budget | Budget release correctness |
| Consuming reservation does not restore budget | **Invariant 8**: Consumed reservation permanent |
| Cannot release already consumed reservation | **Invariant 8**: No double-release |
| Currency mismatch fails reservation | Currency validation |
| 5 simultaneous $30 requests against $100 budget: exactly 3 succeed | **Invariant 7**: Concurrent race invariant |

```bash
npx vitest run tests/unit/budget.test.ts
```

---

#### `tests/unit/audit.test.ts` (8 tests)

| Test | Security Invariant |
|---|---|
| Monotonically increasing sequence numbers | Chain ordering |
| Hash chain linkage correct | **Invariant 14**: Chain integrity |
| Clean chain verifies successfully | Verification baseline |
| Detects tampered event metadata | **Invariant 14**: Tamper detection |
| Detects deleted event (chain break) | **Invariant 14**: Deletion detection |
| Detects reordered events (prev_hash corruption) | **Invariant 14**: Reorder detection |
| Redacts sensitive fields | **Invariant 15**: No secrets in audit |
| Empty chain verifies successfully | Edge case |

```bash
npx vitest run tests/unit/audit.test.ts
```

---

#### `tests/unit/intent.test.ts` (9 tests)

| Test | Security Invariant |
|---|---|
| Creates intent with valid signature | Signing correctness |
| Uses integer minor units (no floating point) | Monetary arithmetic |
| Verifies freshly created intent | Signature validity |
| Fails when amount is tampered | **Invariant 4**: Amount tamper detection |
| Fails when payee is tampered | **Invariant 4**: Payee tamper detection |
| Fails when description is tampered | **Invariant 4**: Field tamper detection |
| Fails with wrong public key | Key binding |
| Detects expired intent | **Invariant 5**: Expiration |
| Valid intent is not expired | Expiration baseline |

```bash
npx vitest run tests/unit/intent.test.ts
```

---

### Integration Tests

#### `tests/integration/payment-flow.test.ts` (7 tests)

| Test | Security Invariant |
|---|---|
| Complete successful payment flow (create→execute→capture) | End-to-end correctness |
| Replay rejected after success | **Invariant 6**: Prohibited replay |
| Over-limit amount denied, provider not called | **Invariant 11**: Forbidden request never reaches provider |
| Expired intent rejected before provider call | **Invariant 5**: Expiration enforcement |
| Provider timeout → RECONCILIATION_REQUIRED, budget held | **Invariant 9**: Timeout ≠ payment failure |
| Tampered signature fails verification | **Invariant 4**: Signature tamper detection |
| Idempotency: same key returns same intent | **Invariant 19**: Idempotent retries |

```bash
npx vitest run tests/integration/payment-flow.test.ts
```

---

### Concurrency Tests

#### `tests/concurrency/budget-race.test.ts` (4 tests)

| Test | Security Invariant |
|---|---|
| 10×$30 against $100 budget: max 3 succeed, total ≤ $100 | **Invariant 7**: Budget invariant under concurrency |
| Exact budget (2×$30 against $60): exactly 2 succeed | **Invariant 7**: No over-spend |
| Full flow: 5×$40 against $100: at most 2 succeed | **Invariant 7**: Full lifecycle race |
| Release restores budget for retry | Budget release correctness |

```bash
npx vitest run tests/concurrency/budget-race.test.ts
```

---

## Security Lab Scenarios (Live API)

These require the server running (`USE_SIMULATOR=true npx tsx src/server.ts`).

Run all via dashboard → ⚔️ Security Lab, or via API:

```bash
# Run a specific scenario
curl -s -X POST http://localhost:3001/api/lab/run-scenario \
  -H "Content-Type: application/json" \
  -d '{"scenario":"tampered_payload"}' | python3 -m json.tool

# All scenario IDs:
# valid_payment, exceed_per_transaction_limit, exhaust_budget,
# unauthorized_payee, expired_intent, replay_attack,
# tampered_payload, budget_race, malicious_ai_output,
# provider_timeout, tampered_audit, malformed_ai_output
```

Each response includes `"passed": true/false` and `"provider_invoked": true/false`.

**For forbidden requests (DENY), provider_invoked must be false.** This is verified by the lab.

---

## Known Limitations and Untested Scenarios

| Gap | Notes |
|---|---|
| Multi-process budget race | SQLite WAL prevents within-process over-spend but NOT across separate Node.js processes sharing the same file. Production needs distributed locking. |
| Webhook forgery | Webhooks not implemented. If added, must verify via PayPal's signature verification API. |
| PayPal live credentials | All tests use simulator or sandbox. No live payment tests. |
| Key rotation | No mechanism to rotate the signing key without invalidating all existing signatures. |
| Rate limiting | API has no rate limiting in this version. Production requires it. |
| Authentication | API is unauthenticated. All invariants hold for the authorization logic but any caller can access any endpoint. |

---

## Audit Chain Verification

```bash
# Verify entire audit chain via API
curl -s -X POST http://localhost:3001/api/audit/verify \
  -H "Content-Type: application/json" -d '{}'

# Expected: {"verification":{"valid":true,"total_events":N,"errors":[],"checked_at":"..."}}
```

After the `tampered_audit` lab scenario, this will return `"valid": false` with error details — demonstrating detection.
