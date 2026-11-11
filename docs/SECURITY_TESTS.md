# Tests and security checks

## Run the checks

From the repository root:

```bash
npm ci
npm test
npm run build
npm audit
```

The automated suite uses in-memory SQLite databases, a local HTTP test server for the OpenAI-compatible AI adapter, and simulated payment providers. It does not require PayPal or AI credentials and does not make live provider calls.

## Coverage

| Area | Checks |
|---|---|
| Policy and budget | Per-transaction and period limits, payees, operations, policy status, atomic reservation, budget changes, reservation release |
| Intents and state | Ed25519 signatures, canonical fields, expiry, replay, approval, allowed state transitions |
| Payment providers | Sandbox payload construction, buyer approval URL, sandbox host restriction, capture result amount and currency |
| Audit | Hash-chain verification, tampering, recursive credential redaction, prompt text excluded from AI proposal audit events |
| AI | OpenRouter and OpenAI configuration selection, OpenAI-compatible request handling, output schema validation, deterministic fallback |

The Security Lab has 12 scenarios. It always uses the simulator; its results do not demonstrate PayPal Sandbox behavior.

## Known limits

- No API authentication, user authorization, or rate limiting. Any process that can reach the local API can access and modify its data.
- The budget invariant is tested for one backend process and one SQLite file. Sharing the file across multiple processes is unsupported.
- The signing key is ephemeral unless `PAYGUARD_SIGNING_KEY` is configured. There is no key rotation procedure.
- PayPal Sandbox and live AI integrations require manual testing with credentials. Automated tests use local fixtures instead.
- `.paytrace` verification checks hashes and chain links. It does not prove the bundle's origin or that a payment settled.
- OpenRouter free models can be unavailable or rate-limited. Prompt handling and retention depend on the selected model provider; do not send secrets or sensitive payment information.
