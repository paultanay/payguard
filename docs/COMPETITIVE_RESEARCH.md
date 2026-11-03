# PayGuard — Competitive Research

**Research date:** 2026-11-02  
**Time-boxed to:** ~60 minutes of parallel web research

---

## Summary of Verified Competitor Landscape

### 1. SpendGuard (devpost.com/software/spendguard)
- **Status:** Submitted to PayPal AI Hackathon 2026.
- **Implemented:** Policy-based limits (per-order, per-day, per-merchant), PayPal integration, denies before PayPal is called.
- **Gaps:** No cryptographic signing of intents, no durable atomic budget reservation under concurrency, no MCP server, no audit hash-chain, no replay/nonce mechanism described.
- **Similarity:** High overlap on concept, but shallow implementation.

### 2. Agentic SpendGuard (github.com/m24927605/agentic-spendguard)
- **Status:** Pre-submission open-source project.
- **Implemented:** KMS-signed decisions, Stripe-style auth/capture ledger, operator approval, multi-tenant, adapters for LangChain/OpenAI SDK.
- **Gaps:** No PayPal integration, no MCP server, no portable audit bundle, no concurrency race tests shown.
- **Similarity:** Partial overlap on budget ledger concept.

### 3. AgentGuard variants (multiple repos)
- GoPlusSecurity, hidearmoon, Mangomindai, WhitzardAgent variants: security firewalls for AI agents, Merkle audit trails, Ed25519 trust attestation.
- **Focus:** General agent security, not specifically payment authorization.
- **Gaps:** No PayPal, no budget reservation, no payment state machine.

### 4. IntentLock (github.com/BrienAustinClayton/intentlock)
- **Status:** PayPal AI Hackathon 2026 entry.
- **Implemented:** "AI-powered autonomous purchase verification layer" — limited detail visible.
- **Gaps:** No public working code or test evidence found.

### 5. SpendMesh AI (github.com/Vinayak1806/Pay-Pal-Hackathon)
- "Zero-trust financial perimeter" — policy enforcement, spend limits.
- **Gaps:** No cryptographic signing, audit chain, or MCP found in description.

### 6. agent-budget-guard (github.com/sasuke15134321/agent-budget-guard)
- Pre-payment control API: budget limits, payment frequency, spending policies.
- **Gaps:** No PayPal, no MCP, no audit chain, no concurrency tests.

### 7. presidio-hardened-x402 (GitHub)
- Security middleware for x402 protocol: PII redaction, spending policy, replay detection via HMAC-SHA256.
- **Focus:** x402/blockchain payments, not PayPal.
- **Gaps:** Different payment rail entirely.

### 8. MCPay, cryptotrust1/ai-agent-crypto-payments
- Crypto-based agent payment protocols.
- **Not relevant:** different payment rail, not PayPal.

---

## Key Differentiators PayGuard Can Demonstrate Uniquely

### A. Atomic Aggregate Budget Reservations Under Concurrency (VERIFIED DIFFERENTIATOR)
- **Research finding:** SpendGuard mentions blocking when "budget gone" but no concurrent test evidence. Agentic SpendGuard has a ledger but no public concurrency test.
- **Our implementation:** SQLite `BEGIN IMMEDIATE` transactions with `UPDATE … WHERE remaining_budget >= amount` atomically deducts. Concurrent test creates N goroutines hitting the same budget slot simultaneously and verifies exact budget enforcement.
- **Verdict:** The test itself is the differentiator. Claiming it without running it is what competitors do. We run it.

### B. Signed, Canonicalized Payment Intents (VERIFIED DIFFERENTIATOR)
- **Research finding:** Agentic SpendGuard uses KMS-signed decisions (not intents). No PayPal-hackathon competitor found with field-level canonical signing of intents.
- **Our implementation:** Ed25519 signatures over a canonical JSON representation binding all security fields. Tamper of any field fails verification.
- **Verdict:** Materially different and demonstrable.

### C. Replay Prevention + Expiration + Idempotency (PARTIAL DIFFERENTIATOR)
- **Research finding:** presidio-hardened-x402 has replay detection via HMAC. For PayPal hackathon scope, none found combining nonce + expiration + idempotency + durable state.
- **Verdict:** Not novel in concept but rare in implementation with PayPal.

### D. PayPal Reconciliation (UNIQUE TO THIS SCOPE)
- **Research finding:** No competitor in PayPal hackathon shows reconciliation between internal state and authoritative PayPal state after timeout.
- **Verdict:** Implementable, demonstrable, unique in context.

### E. Portable Audit Bundle (.paytrace) (NOVEL FORMAT)
- **Research finding:** No competitor found with this concept.
- **Verdict:** Novel project-specific format. Implement audit chain first, add export second.

### F. Attack Simulator (DIFFERENTIATOR)
- **Research finding:** hidearmoon/agentguard has a Merkle audit trail but no attack simulator. No PayPal hackathon entry found with a live attack simulator.
- **Verdict:** Strong demo-time differentiator. Implement after security core.

### G. Semantic Purchase-Intent Check (USEFUL ADDITION)
- **Research finding:** 2026hoohacks/agent-firewall has ALLOW/ASK_USER/DENY with "in scope" checks. None specifically for PayPal payment proposals.
- **Verdict:** Implement as LLM-assisted check that flags mismatches. Deterministic gate remains.

---

## Chosen Differentiator Strategy

**Primary:** Atomic concurrent budget reservation with live concurrency test evidence.  
**Secondary:** Signed canonical payment intents with tamper detection.  
**Tertiary:** Real PayPal Sandbox flow with reconciliation handling.  
**Supporting:** MCP tools, audit hash chain, attack simulator, semantic intent check.

---

## Naming Note

"PayGuard" is a generic compound word. Search finds no registered trademark in the payment/fintech space with an active public-facing product at this name for the exact use case. Using as a hackathon working name is reasonable. Finalist branding should be independently verified.
