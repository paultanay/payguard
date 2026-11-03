# PayGuard — Architecture

## Overview

PayGuard is a local-first authorization gateway that sits between an AI agent and PayPal payment execution. It enforces deterministic spending policies, atomically reserves budget, signs and verifies payment intents, and produces a verifiable audit chain.

```
AI Agent / MCP Client
        │
        ▼
  ┌─────────────┐
  │  MCP Server │  (stdio or HTTP)
  │  Tools:     │
  │  create_proposal
  │  evaluate_policy
  │  request_approval
  │  get_status
  │  get_audit
  └──────┬──────┘
         │
         ▼
  ┌──────────────────────────────────┐
  │         Fastify HTTP API         │
  │  /api/policies  /api/intents     │
  │  /api/transactions  /api/audit   │
  └──────────────┬───────────────────┘
                 │
         ┌───────┴────────┐
         │                │
  ┌──────▼──────┐  ┌──────▼──────┐
  │  Policy     │  │  Payment    │
  │  Engine     │  │  Intent     │
  │  (no LLM)   │  │  (signing)  │
  └──────┬──────┘  └──────┬──────┘
         │                │
  ┌──────▼──────┐  ┌──────▼──────┐
  │  Budget     │  │  State      │
  │  Reserve    │  │  Machine    │
  │  (atomic)   │  │             │
  └──────┬──────┘  └──────┬──────┘
         │                │
  ┌──────▼────────────────▼──────┐
  │          SQLite DB           │
  │  (better-sqlite3, WAL mode)  │
  └──────────────────────────────┘
         │
  ┌──────▼──────┐
  │  Provider   │
  │  Adapter    │
  │  PayPal     │
  │  Simulator  │
  └─────────────┘
         │
  ┌──────▼──────┐
  │  Audit      │
  │  Chain      │
  │  (hash)     │
  └─────────────┘

React Dashboard (Vite, separate port)
```

## Technology Choices

| Concern | Choice | Rationale |
|---------|--------|-----------|
| Runtime | Node.js v26 LTS | Available, proven |
| Language | TypeScript strict | Type safety, Zod integration |
| Backend framework | Fastify | Fast, schema validation built-in |
| Database | SQLite + better-sqlite3 | Synchronous, WAL mode, local-first, atomic UPDATE |
| ORM/Query | Raw SQL + migrations | Full control over locking semantics |
| Schema validation | Zod | Runtime + compile-time |
| Signing | @noble/ed25519 | Audited, zero-dep Ed25519 |
| Test framework | Vitest | Fast, compatible with Node 26 |
| Frontend | React + Vite | SPA, developer-facing |
| MCP | @modelcontextprotocol/server v2 | Official, 2026-07-28 spec |
| AI | openai SDK (optional) | Graceful degradation without key |

## Module Boundaries

```
packages/backend/src/
  policy/          — Policy model, evaluation engine (no LLM)
  intent/          — Payment intent schema, canonical serialization, signing
  budget/          — Atomic budget reservation (SQLite transaction)
  state-machine/   — Payment lifecycle transitions
  approval/        — Approval workflow
  audit/           — Audit event recording, hash chain, verifier
  provider/        — PayPal adapter + deterministic simulator
  ai/              — AI adapter (proposal generation, semantic check)
  mcp/             — MCP server tools
  api/             — Fastify routes
  db/              — Schema, migrations, connection
  crypto/          — Key management, signing utilities

packages/frontend/src/
  views/           — Dashboard views
  components/      — UI components
  hooks/           — Data fetching

packages/mcp/
  — Standalone MCP entry point (imports backend modules)
```

## Database Schema (Key Tables)

- **policies** — id, owner_id, agent_id, rules (JSON), status, version, created_at, expires_at
- **payment_intents** — id, policy_id, nonce, canonical_hash, signature, amount_minor, currency, payee_id, description, state, created_at, expires_at, idempotency_key
- **budget_reservations** — id, intent_id, policy_id, period_key, amount_minor, currency, status, created_at, transaction_id
- **transactions** — id, intent_id, provider_id, provider_mode, state, amount_minor, currency, payee_id, approval_id, created_at, updated_at
- **approvals** — id, intent_id, policy_version, fields_hash, status, approved_by, created_at, expires_at
- **audit_events** — id, sequence_num, prev_hash, event_hash, event_type, entity_id, metadata (JSON), timestamp, signature
- **idempotency_records** — key, intent_id, response_hash, created_at
- **revocation_records** — entity_id, entity_type, revoked_at, reason

## Key Security Properties

1. **Policy-first:** Every payment requires a valid, non-expired, non-revoked policy. No policy → DENY.
2. **Atomic reservations:** SQLite `UPDATE policies SET remaining_budget = remaining_budget - ? WHERE id = ? AND remaining_budget >= ?` in `BEGIN IMMEDIATE` transaction. Atomic deduction before provider call.
3. **Signed intents:** Ed25519 signature over canonical JSON binding: policy_id, agent_id, amount, currency, payee, description, nonce, expires_at. Verification before any state transition.
4. **Replay prevention:** Nonce stored durably; second use of same nonce → REJECT. Expiration enforced at verification time.
5. **State machine:** Only backend can advance state. Frontend cannot directly set SUCCEEDED.
6. **Audit chain:** Each event includes SHA-256 of previous event. Verifier checks chain integrity.
7. **Provider abstraction:** PayPal adapter and simulator share identical interface. Offline mode clearly labeled.

## Trust Boundaries

```
UNTRUSTED: AI agent, MCP client, browser frontend, webhook body
TRUSTED:   Backend process, SQLite DB (local), signing key (in-memory/env)
EXTERNAL:  PayPal API (trusted for payment state, not for authorization decisions)
```

## State Machine

```
PROPOSED → PENDING_APPROVAL → RESERVED → PAYMENT_PENDING → AUTHORIZED
         ↗                  ↘ FAILED    → CAPTURE_PENDING → SUCCEEDED
                                        ↓                 ↘ FAILED
                                    RECONCILIATION_REQUIRED
                    EXPIRED ← (timeout)
                    RELEASED ← (budget released)
```

## Deployment Model

Single-process, single-SQLite-file. Budget invariants hold within one process.
Multi-instance safety: NOT guaranteed. Documented limitation.
