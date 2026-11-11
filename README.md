# PayGuard

Payment authorization for AI-assisted purchasing.

[![Tests](https://img.shields.io/badge/tests-85%20passing-brightgreen)](#testing)
[![License](https://img.shields.io/badge/license-MIT-blue)](#license)
[![Provider](https://img.shields.io/badge/provider-PayPal%20Sandbox-003087)](#paypal-sandbox-setup)

---

## Overview

PayGuard is a local service that checks proposed purchases against deterministic spending policies before creating PayPal Sandbox orders. It signs payment intents, reserves budget in SQLite, and records an audit chain.

The flow is:
```
AI proposes → policy evaluates → human approves if required → PayPal Sandbox processes → audit records the result
```

## Capabilities and limits

| Capability | What the demo proves | Boundary |
|---|---|---|
| **Signed payment intents** | Ed25519 signature binds amount, currency, payee, agent, policy, nonce, and expiry | A local signing key; not an external identity proof |
| **Atomic budget reservation** | SQLite serializes reservations and prevents over-spend in the tested single-process deployment | One process and one SQLite database |
| **Replay and expiry checks** | Reused or expired intents are rejected before provider execution | Within this local service and database |
| **PayTrace evidence** | Exported `.paytrace` JSON can be checked offline for hash and chain consistency | Project-specific format; not an external trust anchor |
| **PayPal Sandbox checkout** | Buyer approval link followed by explicit capture after approval | Sandbox only; must be configured and exercised by the entrant |
| **AI proposal and semantic check** | OpenRouter or OpenAI turns a request into a structured proposal and can flag a mismatch | Advisory only; deterministic policy remains authoritative |
| **Security Lab** | Attack scenarios exercise real policy and transaction code | The lab always uses the simulator |

---

## Prerequisites

- **Node.js** v20+ (tested on v26)
- **npm** v10+
- **Git**

Optional:
- PayPal Sandbox credentials (from [developer.paypal.com](https://developer.paypal.com))
- An [OpenRouter API key](https://openrouter.ai/keys) for free model testing, or an OpenAI API key for direct OpenAI access. Without either, the app labels and uses a deterministic fallback.

---

## Installation

```bash
git clone https://github.com/paultanay/payguard.git
cd payguard

# Install locked workspace dependencies
npm ci
```

---

## Environment Setup

```bash
cp -n .env.example .env
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

For free AI testing through OpenRouter, set these values in `.env`:
```env
AI_PROVIDER=openrouter
OPENROUTER_API_KEY=your_openrouter_api_key
AI_MODEL=openrouter/free
```

OpenRouter's `openrouter/free` route chooses from currently available free models. You can instead set `AI_MODEL` to a specific model ID from [OpenRouter's free model catalog](https://openrouter.ai/collections/free-models), including compatible Google or NVIDIA models when listed there. Free models can be rate-limited or unavailable, and model/provider data handling varies; do not send secrets or sensitive payment information in prompts. If only `OPENROUTER_API_KEY` is configured, PayGuard selects OpenRouter automatically. To use OpenAI directly, set `AI_PROVIDER=openai`, `OPENAI_API_KEY`, and an OpenAI model in `AI_MODEL`.

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
# Current suite: 85 tests across 12 test files
# Build backend, dashboard, and MCP package
npm run build
```

The suite covers cryptographic signing, policy decisions, budget reservations, provider adapters, audit integrity, payment lifecycle integration, and concurrent budget requests.

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

The Security Lab runs 12 scenarios against application policy and transaction code:

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

## Technical documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Security tests](docs/SECURITY_TESTS.md)

---

## License

MIT — see [LICENSE](./LICENSE)
