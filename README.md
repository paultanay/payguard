# 🛡️ PayGuard — AI Payment Authorization Gateway

> **PayPal AI Hackathon 2026 Submission**  
> A local-first, developer-facing authorization gateway for AI-agent payment workflows.

[![Tests](https://img.shields.io/badge/tests-74%20passing-brightgreen)](#testing)
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

## What PayGuard Demonstrates

PayGuard is a local payment authorization gateway, not a shopping agent. Its clearest technical story is that each proposed payment is bound to a signed intent, checked by deterministic policy, and represented in a portable audit bundle.

| Capability | What the demo proves | Boundary |
|---|---|---|
| **Signed payment intents** | Ed25519 signature binds amount, currency, payee, agent, policy, nonce, and expiry | A local signing key; not an external identity proof |
| **Atomic budget reservation** | SQLite serializes reservations and prevents over-spend in the tested single-process deployment | One process and one SQLite database |
| **Replay and expiry checks** | Reused or expired intents are rejected before provider execution | Within this local service and database |
| **PayTrace evidence** | Exported `.paytrace` JSON can be checked offline for hash and chain consistency | Project-specific format; not an external trust anchor |
| **PayPal Sandbox checkout** | Buyer approval link followed by explicit capture after approval | Sandbox only; must be configured and exercised by the entrant |
| **AI proposal and semantic check** | OpenAI model turns a request into a structured proposal and can flag a mismatch | Advisory only; deterministic policy remains authoritative |
| **Security Lab** | Attack scenarios exercise real policy and transaction code | The lab always uses the simulator |

Several current hackathon submissions describe overlapping AI payment guardrails. PayGuard's entry should focus on signed authorization details and portable tamper-evidence, and should avoid claims that the overall guardrail idea or individual features are unique.

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
- OpenAI API key for actual AI proposal generation and semantic checks (without it, the app labels and uses a deterministic fallback)

---

## Installation

```bash
git clone https://github.com/paultanay/payguard.git
cd payguard

# Install all workspace dependencies
npm install
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
# From the repository root
npm test
# Current suite: 74 tests across 10 test files

# Build backend, dashboard, and MCP package
npm run build
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
Build first with `npm run build`, then point the client at the compiled entry point:
```json
{
  "mcpServers": {
    "payguard": {
      "command": "node",
      "args": ["/absolute/path/to/payguard/packages/mcp/dist/mcp/src/index.js"],
      "env": {
        "USE_SIMULATOR": "true",
        "DB_PATH": "/absolute/path/to/payguard/data/payguard.db"
      }
    }
  }
}
```

The stdio server starts when launched by the client; its five tools can then be discovered and invoked through the MCP client.

---

## PayPal Sandbox Setup

1. Go to [developer.paypal.com](https://developer.paypal.com) → Dashboard → Apps & Credentials
2. Select **Sandbox** environment
3. Create a new app or use the default
4. Copy **Client ID** and **Secret** into `.env`
5. Note your sandbox **business account email** and use it as `payee_id` in payment intents. PayGuard sends email addresses using PayPal's `email_address` field; other payee IDs are sent as `merchant_id`.

**Sandbox buyer approval flow:**
The normal PayPal flow requires buyer approval at PayPal's URL. In sandbox mode:
1. Create and execute an intent from Agent Activity → receive a PayPal approval link
2. Open the approval link in a browser logged in as your **sandbox buyer account**
3. Approve the payment
4. PayPal redirects back to the Transactions page
5. Click **Capture** for the pending transaction. PayGuard waits for buyer approval before capture.

The **simulator mode** skips PayPal and buyer approval entirely. Use it for offline development; it does not demonstrate the required PayPal integration.

---

## Security Lab

The Security Lab (dashboard → ⚔️ Security Lab) runs 12 attack scenarios against real application code:

All Security Lab scenarios intentionally use the simulated provider, even if PayPal Sandbox is configured. The lab results are labeled SIMULATED; they are not evidence of a Sandbox payment.

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

## AI Tools

- **In the product:** OpenAI API (default model: `gpt-4o-mini`, configurable with `AI_MODEL`) generates structured purchase proposals and performs an advisory semantic check. Zod validates model output. The deterministic policy engine—not the model—authorizes or denies spending. Without an API key, the UI labels and uses a deterministic fallback; that mode is not an AI demonstration.
- **During development:** OpenAI Codex assisted with implementation and review. The entrant should disclose development assistance accurately in the submission and remain able to explain and verify the work.

---

## Hackathon Submission

- **Event**: [PayPal AI Hackathon 2026](https://paypalaihackathon.devpost.com/)
- **Deadline**: November 12, 2026 12:00 PM Pacific
- **Demo video**: Not recorded yet. The rules require a publicly visible YouTube video under 3 minutes that shows a working project.
- **Live demo / setup**: Follow the local setup above. Configure PayPal Sandbox and an AI key to demonstrate both required technologies; simulator and deterministic fallback are offline modes.
- **Readiness**: This is a prototype, not ready to submit until the PayPal Sandbox approval/capture flow and actual AI path are exercised, then the public repository and video are linked on Devpost.
