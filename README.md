# 🛡️ PayGuard — AI Payment Authorization Gateway

> **PayPal AI Hackathon 2026 Submission**  
> A local-first, developer-facing authorization gateway for AI-agent payment workflows.

[![Tests](https://img.shields.io/badge/tests-62%20passing-brightgreen)](#testing)
[![License](https://img.shields.io/badge/license-MIT-blue)](#license)
[![Provider](https://img.shields.io/badge/provider-PayPal%20Sandbox-003087)](#paypal-sandbox-setup)

---

## What Is PayGuard?

PayGuard sits between an AI agent and payment execution. It enforces deterministic spending policies, atomically reserves budget under concurrency, signs and verifies payment intents cryptographically, and produces a tamper-evident audit trail — all before a single dollar moves.

**Core principle:**
```
AI proposes → Policy engine decides → Gateway controls execution → PayPal reports state → Audit records everything
```

The LLM is never the final security boundary.

---

## Key Differentiators

| Feature | PayGuard | Typical competitor |
|---|---|---|
| **Atomic budget reservation** | SQLite `UPDATE … WHERE remaining >= amount` in `BEGIN IMMEDIATE` — concurrent over-spend impossible within one process | Read-check-write race condition |
| **Signed canonical intents** | Ed25519 over all security fields; tamper of any field fails verification | Amount-only or no signing |
| **Replay prevention** | Nonce + expiration + idempotency, durably stored | In-memory only |
| **Reconciliation state** | Provider timeout → RECONCILIATION_REQUIRED, budget held | Silent failure or budget released |
| **Attack simulator** | 12 scenarios calling real policy/transaction code | Scripted demo |
| **Semantic intent check** | AI flags when proposal doesn't match original request | None |
| **MCP v2 tools** | 5 real tools over stdio (2026-07-28 spec) | REST endpoints labeled as MCP |
| **Audit hash chain** | SHA-256 chain, independent verifier detects tampering | Append-only log |

---

## Architecture

```
AI Agent / MCP Client
        │
        ▼
  MCP Server (stdio)          ← @modelcontextprotocol/server v2
        │
        ▼
  Fastify HTTP API (:3001)
        │
  ┌─────┴──────┐
  │            │
Policy      Payment Intent
Engine      (Ed25519 signed)
  │            │
Budget      State Machine
Reservation  (validated transitions)
(atomic)        │
  └─────┬──────┘
        │
  Provider Adapter
  ├── PayPal Sandbox (AUTHORIZE→CAPTURE)
  └── Deterministic Simulator (offline)
        │
  Audit Chain (SHA-256 hash chain)
        │
  SQLite (WAL mode, single-process guarantee)
        │
  React Dashboard (:5173)
```

---

## Prerequisites

- **Node.js** v20+ (tested on v26)
- **npm** v10+
- **Git**

Optional:
- PayPal Sandbox credentials (from [developer.paypal.com](https://developer.paypal.com))
- OpenAI API key (for AI proposal generation; falls back to deterministic without it)

---

## Installation

```bash
git clone https://github.com/your-username/payguard.git
cd payguard

# Install all workspace dependencies
npm install
npm install-scripts approve esbuild
npm install-scripts approve better-sqlite3
```

---

## Environment Setup

```bash
cp .env.example .env
```

Edit `.env`. The minimum required for offline/simulated mode — **no credentials needed**:

```env
USE_SIMULATOR=true
PORT=3001
```

For PayPal Sandbox (see [PayPal Sandbox Setup](#paypal-sandbox-setup)):
```env
PAYPAL_CLIENT_ID=your_sandbox_client_id
PAYPAL_CLIENT_SECRET=your_sandbox_client_secret
PAYPAL_BASE_URL=https://api-m.sandbox.paypal.com
USE_SIMULATOR=false
```

---

## Running the Application

### Development (two terminals)

**Terminal 1 — Backend API:**
```bash
cd packages/backend
USE_SIMULATOR=true npx tsx src/server.ts
# → API running at http://localhost:3001
# → Health: http://localhost:3001/health
```

**Terminal 2 — Frontend Dashboard:**
```bash
cd packages/frontend
npx vite --port 5173
# → Dashboard at http://localhost:5173
```

### Single command (from project root):
```bash
npm run dev
```

### Verify it's working:
```bash
curl http://localhost:3001/health
# {"status":"ok","provider_mode":"simulated","timestamp":"..."}
```

---

## Testing

```bash
# Run all tests (unit + integration + concurrency)
cd packages/backend
npx vitest run --reporter=verbose

# Output: 62 tests across 7 test files, all passing
```

**Test categories:**
- **Unit**: Crypto (Ed25519, SHA-256, canonical JSON), Policy engine (ALLOW/DENY/REQUIRE_APPROVAL), Budget reservations, Audit chain
- **Integration**: Full payment flow, replay prevention, expiry, timeout reconciliation, idempotency, signature tamper detection
- **Concurrency**: Budget race — N×$30 against $100 budget simultaneously, invariant verified

---

## MCP Server Setup

The MCP server exposes 5 tools over stdio using the official `@modelcontextprotocol/server` v2 SDK.

**Tools:**
- `create_payment_proposal` — create and policy-evaluate a signed intent
- `evaluate_payment_policy` — dry-run policy check without reserving budget
- `get_payment_status` — get intent + transaction state
- `request_payment_approval` — surface approval requirement to human
- `get_audit_evidence` — retrieve audit trail + chain integrity

**Configure in your MCP client** (e.g. Claude Desktop `mcp_settings.json`):
```json
{
  "mcpServers": {
    "payguard": {
      "command": "node",
      "args": ["--import", "tsx/esm", "/absolute/path/to/payguard/packages/mcp/src/index.ts"],
      "env": {
        "USE_SIMULATOR": "true",
        "DB_PATH": "/absolute/path/to/payguard/data/payguard.db"
      }
    }
  }
}
```

**Test MCP from CLI:**
```bash
# Requires a policy to exist first (create via dashboard or API)
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | \
  cd packages/mcp && USE_SIMULATOR=true npx tsx src/index.ts
```

---

## PayPal Sandbox Setup

1. Go to [developer.paypal.com](https://developer.paypal.com) → Dashboard → Apps & Credentials
2. Select **Sandbox** environment
3. Create a new app or use the default
4. Copy **Client ID** and **Secret** into `.env`
5. Note your sandbox **merchant account email** — use it as `payee_id` in payment intents

**Sandbox buyer approval flow:**
The normal PayPal flow requires buyer approval at PayPal's URL. In sandbox mode:
1. Create an intent via the dashboard or API
2. Execute the intent → receive `approval_url`
3. Open `approval_url` in a browser logged in as your **sandbox buyer account**
4. Approve the payment
5. You'll be redirected back to `http://localhost:3001/payment/return?intent_id=...`
6. Call `POST /api/transactions/:id/capture` to capture

The **simulator mode** skips buyer approval entirely and auto-approves, enabling fully offline demos.

---

## Security Lab

The Security Lab (dashboard → ⚔️ Security Lab) runs 12 attack scenarios against real application code:

1. Valid payment (baseline)
2. Exceed per-transaction limit
3. Exhaust aggregate budget
4. Unauthorized payee
5. Expired intent
6. Replay attack
7. Tampered signed payload
8. Budget race (concurrent)
9. Malicious AI output (budget override attempt)
10. Provider timeout (reconciliation)
11. Tampered audit record
12. Malformed AI output (schema validation)

Each scenario shows: input, expected result, actual result, whether provider was invoked, audit evidence.

---

## Demo Reset

To reset all data and start fresh:

```bash
# Stop the server, then:
rm -f data/payguard.db
# Restart the server — schema is recreated automatically
```

---

## API Reference

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Health check + provider mode |
| GET | `/api/stats` | Dashboard totals from persisted DB |
| POST | `/api/policies` | Create spending policy |
| GET | `/api/policies` | List all policies |
| PATCH | `/api/policies/:id` | Update policy |
| DELETE | `/api/policies/:id` | Revoke policy |
| POST | `/api/intents` | Create + evaluate payment intent |
| POST | `/api/intents/:id/execute` | Execute payment (reserve budget + call provider) |
| GET | `/api/transactions` | List transactions |
| POST | `/api/transactions/:id/capture` | Capture authorized payment |
| GET | `/api/approvals/pending` | List pending approvals |
| POST | `/api/approvals/:id/approve` | Approve a payment |
| POST | `/api/approvals/:id/reject` | Reject a payment |
| GET | `/api/audit` | Audit event log |
| POST | `/api/audit/verify` | Verify chain integrity |
| POST | `/api/ai/propose` | AI-assisted purchase proposal |
| POST | `/api/ai/semantic-check` | Semantic intent verification |
| POST | `/api/lab/run-scenario` | Run attack simulation scenario |

---

## Security Limitations

- **Single-process only**: Budget invariant guaranteed within one Node.js process + one SQLite file. Multi-instance deployments require an external distributed lock or a distributed database.
- **Local signing key**: Ed25519 private key is in-memory. A party controlling the process and DB can reconstruct the audit chain. The audit chain detects external tampering, not insider attacks with full access.
- **Audit chain is not a blockchain**: Records can be rewritten by someone with DB write access + the signing key. Claim: detects accidental modification and external database tampering.
- **AI semantic check is advisory**: It flags mismatches but cannot prevent all prompt injection. The deterministic policy engine is the final gate.
- **No authentication**: The API has no authentication layer (by design for the hackathon demo). Production use requires bearer tokens or mTLS on all endpoints.
- **PayPal Sandbox only**: The app refuses to operate with live PayPal credentials.

---

## License

MIT — see [LICENSE](./LICENSE)

---

## Hackathon Submission

- **Event**: [PayPal AI Hackathon 2026](https://paypalaihackathon.devpost.com/)
- **Deadline**: November 12, 2026 12:00 PM Pacific
- **Demo video**: [YouTube link — to be added before submission]
- **Live demo / setup**: Follow README instructions above for full local reproduction
