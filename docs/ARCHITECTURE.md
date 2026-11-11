# Architecture

PayGuard is a local service with a React dashboard and an optional MCP server. The backend uses one SQLite database and one payment provider per process.

## Components

| Package | Responsibility |
|---|---|
| `packages/backend` | Fastify API, policy evaluation, intent signing, budget reservations, approvals, provider calls, and audit records |
| `packages/frontend` | React dashboard served by Vite in development and Fastify in a production build |
| `packages/mcp` | MCP server over stdio; imports backend services and uses the configured database and provider |

The backend and MCP server load configuration from the repository root `.env`. `DB_PATH` may be absolute or relative to the repository root. The HTTP server binds to `127.0.0.1` by default.

## Payment flow

1. `POST /api/ai/propose` asks the configured OpenRouter or OpenAI model for a structured proposal. Without a configured key, it returns a deterministic fallback marked as non-AI.
2. `POST /api/intents` signs the payment fields and evaluates them against the selected policy. A policy denial does not call the payment provider. Policies that require review create a pending approval.
3. `POST /api/intents/:id/execute` verifies the signed intent and expiry, checks approval when required, reserves budget in a SQLite transaction, then creates a PayPal Sandbox order or a simulated order.
4. For PayPal, the buyer approves the order at PayPal. The operator then captures it from Transactions.
5. PayGuard compares the captured amount and currency with the intent, updates the reservation and state, and records the result in the audit log.

The AI output is advisory. The deterministic policy engine controls authorization.

## Data and state

SQLite stores policies, payment intents, approvals, transactions, budget reservations, idempotency records, revocations, and audit events. The schema is defined in `packages/backend/src/db/schema.ts`.

Intents are signed with Ed25519 over canonicalized payment fields. Their lifecycle updates are checked against `packages/backend/src/state-machine/transitions.ts`. Budget reservations use a `BEGIN IMMEDIATE` transaction and an atomic update to the policy's remaining budget.

Audit events contain a SHA-256 hash of their canonical fields and the previous event hash. The `.paytrace` export can verify those hashes and links offline. It has no external signature or trust anchor, so it does not establish who created the file or whether a payment settled.

## Provider and AI configuration

The payment adapter supports PayPal Sandbox and an in-memory simulator. It rejects non-Sandbox PayPal API hosts. Security Lab scenarios always use the simulator.

The AI adapter uses the OpenAI SDK's chat completion interface. `AI_PROVIDER` selects `openai` or `openrouter`; `AI_MODEL` selects the model. If only `OPENROUTER_API_KEY` is set, the adapter selects OpenRouter and defaults to `openrouter/free`. If no supported key is set, proposal generation uses its deterministic fallback and semantic checks report that no AI call was made.

## Runtime limits

- The API has no authentication or per-user authorization. Keep it on loopback and do not expose it to untrusted clients.
- Budget guarantees apply to one process using one SQLite database file. Multiple backend or MCP processes sharing that file are not supported.
- The signing key is generated in memory unless `PAYGUARD_SIGNING_KEY` is set. Generated signatures do not survive a restart.
- PayPal live payments and webhooks are not supported.
