# PayGuard — Threat Model

## Protected Assets

| Asset | Description |
|---|---|
| User funds | Money in the user's PayPal account |
| Spending policy | Configured limits and authorized payees |
| Payment intents | Signed records of authorized payment proposals |
| Signing private key | Ed25519 key used to sign intents |
| PayPal credentials | Sandbox client ID and secret |
| Audit log | Tamper-evident event chain |
| Budget remaining | Real-time available spend against policy |

---

## Trust Boundaries

```
UNTRUSTED (validate everything from here):
  - AI agent output
  - MCP client requests
  - Browser / frontend
  - Webhook body from PayPal
  - Environment variables at runtime (if compromised)

TRUSTED (within the process boundary):
  - Backend policy engine
  - SQLite database (local file)
  - Signing key (in-memory, loaded from env)

EXTERNAL (trusted for payment state, not for authorization):
  - PayPal API (authoritative for payment outcome after execution)
```

---

## Adversaries

| Adversary | Capability |
|---|---|
| Malicious AI agent | Can craft any MCP tool arguments or API request |
| Prompt-injected agent | Has been fed adversarial instructions via tool results |
| Compromised MCP client | Can call any exposed tool with arbitrary arguments |
| Browser attacker | Can forge frontend requests to the API |
| Network attacker (MITM) | Can intercept HTTP traffic (localhost — low risk, but HTTPS needed in production) |
| Malicious PayPal webhook | Can POST arbitrary JSON to webhook endpoint |
| Database attacker | Has read/write access to SQLite file |
| Insider with full access | Has DB + signing key + process access |

---

## Attack Paths and Controls

### 1. AI agent attempts to authorize an over-budget payment

**Path**: Agent creates intent with `amount_minor > budget_limit_minor`  
**Control**: Policy engine `evaluate()` returns DENY before any reservation. No budget is touched. No provider is called.  
**Test**: `exceed_per_transaction_limit` scenario; `policies.test.ts: denies when amount exceeds per-transaction limit`  
**Evidence**: Provider adapter `createOrder` never invoked on DENY path (verified in lab scenario)

---

### 2. Agent attempts to pay an unauthorized merchant

**Path**: Agent sets `payee_id` to a merchant not in `allowed_payees`  
**Control**: Policy engine checks `allowed_payees` list; DENY if payee not present  
**Test**: `unauthorized_payee` scenario; `policies.test.ts: denies when payee not in allowed list`

---

### 3. Prompt injection modifies transaction amount after proposal

**Path**: Agent proposes $20 keyboard, prompt injection changes amount to $9,999 before intent creation  
**Control**: Canonical intent is signed with Ed25519 over all fields including `amount_minor`. Amount in DB tampered → canonical hash mismatch → signature verification fails → FAILED state, provider never called  
**Test**: `tampered_payload` scenario; `intent.test.ts: fails when amount is tampered`

---

### 4. Prompt injection changes payee after signing

**Path**: Signed intent for `merchant_a`, DB updated to `evil_merchant`  
**Control**: Same Ed25519 signature check — payee is in canonical fields  
**Test**: `intent.test.ts: fails when payee is tampered`

---

### 5. Replay attack — re-execute an already-succeeded intent

**Path**: Agent calls `POST /api/intents/:id/execute` on an intent already in SUCCEEDED state  
**Control**: `executePayment` checks `intentRow.state === 'SUCCEEDED'` → REPLAY rejection before any processing  
**Test**: `replay_attack` scenario; `payment-flow.test.ts: replay is rejected after success`

---

### 6. Concurrent over-spend (budget race)

**Path**: 10 agents simultaneously request $30 against a $100 budget  
**Control**: Atomic `UPDATE policies SET remaining_budget_minor = remaining_budget_minor - ? WHERE … AND remaining_budget_minor >= ?` inside `BEGIN IMMEDIATE` transaction. If the UPDATE changes 0 rows, reservation fails — provider is never called  
**Test**: `budget_race` scenario; `budget-race.test.ts: INVARIANT: sum of successful reservations never exceeds budget limit`  
**Limitation**: Holds within one SQLite process. Multi-process not safe.

---

### 7. Provider timeout with unknown outcome

**Path**: PayPal call times out — did the payment succeed or not?  
**Control**: On `PROVIDER_TIMEOUT` error code, budget reservation is NOT released. State → `RECONCILIATION_REQUIRED`. Operator must manually verify via `GET /api/transactions/:id` and reconcile  
**Test**: `provider_timeout` scenario; `payment-flow.test.ts: provider timeout enters reconciliation state without releasing budget`

---

### 8. Malicious AI output attempting to override policy

**Path**: LLM outputs `{"budget_override": 999999, "estimated_amount_minor": -1}`  
**Control**: `PurchaseProposalSchema` (Zod) validates all AI output. Invalid fields (unknown keys ignored by default, negative amounts rejected). Policy engine evaluates independently of AI  
**Test**: `malicious_ai_output` and `malformed_ai_output` scenarios

---

### 9. Forged webhook

**Path**: Attacker posts fake PayPal webhook claiming a payment succeeded  
**Control (current)**: Webhooks are not implemented in this version. No route accepts webhook-triggered state changes. State changes only via authenticated server-side API calls.  
**Residual risk**: If webhooks are added later, they must verify using PayPal's `POST /v1/notifications/verify-webhook-signature` endpoint before trusting any payload.

---

### 10. Expired authorization reused

**Path**: Agent holds an old intent past its TTL and attempts execution  
**Control**: `executePayment` checks `intentRow.expires_at` before any other processing. Returns EXPIRED, budget never reserved  
**Test**: `expired_intent` scenario; `payment-flow.test.ts: expired intent is rejected before provider call`

---

### 11. Approval for different transaction amount

**Path**: Approval created for $19.99 keyboard; attacker modifies intent amount to $500 before approval is consumed  
**Control**: `ApprovalService.approve()` recomputes `fields_hash` from current DB values and compares to stored hash. Mismatch → approval rejected  
**Code**: `approval/service.ts: approve()` — fields_hash check  
**Test**: Covered by integration test + approval service logic

---

### 12. Audit log tampering

**Path**: Attacker modifies an audit event's metadata to change recorded amount  
**Control**: Hash chain — each event's `event_hash` covers all fields including metadata. Verifier recomputes and compares. Mismatch detected.  
**Test**: `tampered_audit` scenario; `audit.test.ts: detects tampered event metadata`  
**Limitation**: An insider with DB write access and the signing key can reconstruct a new valid chain.

---

### 13. Credential leakage via API response or logs

**Path**: PayPal client secret returned in API response or logged  
**Control**: `sanitizeResponse()` in PayPal adapter removes sensitive fields. Audit redactor strips keys containing "secret", "token", "key", "credential" etc. Server logger does not log request bodies.  
**Test**: `audit.test.ts: redacts sensitive fields from metadata`

---

### 14. Browser directly marking a payment as SUCCEEDED

**Path**: Frontend POSTs directly to change state to SUCCEEDED  
**Control**: No API endpoint allows setting state to SUCCEEDED directly. State advances only via `capturePayment()` after confirmed provider response  
**Code**: `state-machine/transitions.ts` — actor constraints prevent AI agent or MCP client from directly succeeding

---

## Residual Risks

| Risk | Severity | Mitigation Status |
|---|---|---|
| Multi-process budget over-spend | High | **Not mitigated** — documented limitation, single-process only |
| Insider attack (DB + key access) | High | **Partial** — audit chain detects external tampering, not insider |
| No API authentication | High | **Not mitigated** — production requires bearer tokens or mTLS |
| Prompt injection in semantic check | Medium | **Partial** — flagged for review, deterministic gate is final |
| Ephemeral signing key (no env var set) | Medium | **Documented** — warn at startup, recommend key persistence |
| PayPal API rate limits / transient errors | Low | **Mitigated** — error handling, reconciliation state |
| Dependency compromise | Low | **Partial** — pinned versions, minimal deps |

---

## What PayGuard Does NOT Claim

- It does not prevent all prompt injection
- It does not provide legal non-repudiation
- It does not guarantee correctness in multi-instance deployments
- It does not protect against an attacker who controls both the DB and the signing key
- It does not replace PayPal's own fraud detection
- Audit evidence in SIMULATED mode cannot be verified against PayPal's records
