# PayGuard — Current Status

**Reviewed:** November 7, 2026 (IST)
**Hackathon deadline:** November 12, 2026, 12:00 PM Pacific / November 13, 2026, 1:30 AM IST

## Readiness

**The local prototype is runnable; the submission is not ready yet.** Code-level checks pass, but neither PayPal Sandbox nor the real AI provider has been exercised because credentials are not configured. The current GitHub remote also did not resolve as a public repository when checked. The video and Devpost entry are not complete.

## Verified in this workspace

- `npm test`: 74 tests pass across 10 test files.
- `npm run build`: backend, frontend, and MCP package build successfully.
- `npm audit`: zero known vulnerabilities at review time.
- Built backend starts with an isolated temporary DB; `/health`, dashboard HTML, and compiled asset returned HTTP 200.
- MCP stdio initialized, listed all five tools, and returned a successful `get_audit_evidence` tool call.
- All 12 Security Lab scenarios passed against separate in-memory databases; every result reported simulated provider mode.
- AI fallback preserves an explicitly requested over-limit amount so policy—not proposal generation—can deny it.
- PayPal Sandbox adapter supports email payees and permits only PayPal's official Sandbox API host.
- Dashboard preserves buyer approval and waits for manual capture.
- A capture amount/currency mismatch enters reconciliation and holds the budget reservation.
- Security Lab labels its own payment provider as simulated.
- Backend and MCP startup respect `DB_PATH`; `.env` is loaded quietly; the API defaults to loopback.

## Required before submitting

1. Configure PayPal Sandbox client credentials and a sandbox business/buyer account. Complete one real buyer approval and capture from the dashboard.
2. Configure an OpenAI API key and run a real proposal plus semantic check. Record which model/provider actually ran.
3. Verify an over-limit proposal is denied without a PayPal request.
4. Verify the GitHub repository is public, contains all source and instructions, and displays the MIT license.
5. Record an English video under 3 minutes showing the actual working flow, upload it publicly to YouTube, and add that link to Devpost.
6. Complete the Devpost form, disclose runtime AI and coding-assistant tools accurately, and submit before the deadline.

## Competitive position

Several entries publicly describe similar AI payment guardrails, including Sandbox checkout, approvals, AI risk review, MCP, or atomic budgets. PayGuard's clearest demonstrable angle is its signed authorization intent and offline-verifiable `.paytrace` evidence bundle. Do not claim that the broad concept or these individual features are unique.

## Limitations

- No API authentication or rate limiting; the demo binds to loopback by default and should remain in a trusted local environment.
- Atomic budget guarantee is for one process and one SQLite database.
- Signing key is ephemeral unless `PAYGUARD_SIGNING_KEY` is configured.
- AI semantic checks are advisory and cannot authorize payments.
- `.paytrace` checks hash and chain consistency; it is not signed by an external trust authority.
- Security Lab scenarios use the simulator and do not prove PayPal Sandbox behavior.
