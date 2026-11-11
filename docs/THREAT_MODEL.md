# Threat model

## Scope

PayGuard is a local prototype for policy-gated PayPal Sandbox orders. It is not a production payment service. It has no user authentication, per-user authorization, or reconciliation resolution endpoint.

## Assets

- PayPal Sandbox client credentials
- `PAYGUARD_SIGNING_KEY`
- Payment intents, approval records, and spending policies
- Budget reservations and transaction state
- Audit events and exported `.paytrace` files
- Prompts sent to an external AI provider

## Trust boundaries

| Source | Handling |
|---|---|
| AI output | Treated as untrusted input, validated against a schema, and never allowed to authorize spending |
| Browser and MCP clients | Requests are validated, but clients are not authenticated or assigned distinct permissions |
| SQLite database | Local process storage; a party with write access can alter records and recompute the hash chain |
| OpenRouter or OpenAI | Receives proposal and semantic-check prompts when configured; handling and retention depend on the selected provider and model |
| PayPal | Sandbox is authoritative for provider order and capture responses; it does not make PayGuard policy decisions |

## Controls

- Policies check agent, operation, currency, per-transaction amount, allowed payees, expiry, and budget.
- Intents are signed with Ed25519 and checked before execution. Policy updates invalidate signatures through the policy version.
- Budget reservations use SQLite write transactions and conditional updates. The guarantee applies to one service process and one database file.
- Human approval is bound to the amount, currency, payee, and description. Rejected approvals fail the associated intent.
- PayPal credentials are sent only to `https://api-m.sandbox.paypal.com`. Capture results are checked against the authorized amount and currency.
- AI proposal text is not written to the audit log. Audit metadata redacts credential-like field names, including nested objects and arrays.
- The `.paytrace` verifier checks event hashes and chain links. It does not authenticate the exporter or prove payment settlement.

## Risks and limits

| Risk | Effect | Current limit |
|---|---|---|
| Unauthenticated local API | Any process that can reach the API can read or change policies and payment data | Default bind is loopback; this does not protect against other local processes. Do not expose the API to a network. |
| Multiple backend processes | Concurrent budget updates may not preserve the single-process invariant | Shared-file multi-process operation is unsupported. |
| Compromised database and signing key | An attacker can change data and rebuild valid local signatures or audit records | No external signing or audit authority is used. |
| Missing signing key | Restart generates a new key and old signatures no longer verify | Configure `PAYGUARD_SIGNING_KEY` for a persistent local demo. There is no key rotation process. |
| Provider timeout or capture mismatch | Payment outcome can be uncertain while the budget remains reserved | PayGuard marks the record `RECONCILIATION_REQUIRED`; it has no endpoint to resolve that state. |
| Prompt disclosure | Prompts leave the application when an AI provider is configured | Do not include secrets, personal data, or payment credentials in prompts. |
| No rate limiting | Local callers can generate requests without an application-level quota | No rate limiter is implemented. |
| Webhook spoofing | Not applicable to current flow | Webhooks are not implemented or accepted. |

The API and dashboard are intended for local evaluation only. The default bind address is `127.0.0.1`; changing `HOST` can expose the unauthenticated API to other machines.
