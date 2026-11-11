# PayGuard — Hackathon Demo Script

**Target runtime:** 2:45 maximum
**For the submitted video:** use a configured OpenAI-compatible AI provider and PayPal Sandbox. Simulator/fallback runs are useful backups, but do not demonstrate the event's required PayPal and AI integrations.

## Before recording

- Set PayPal Sandbox credentials and either `OPENROUTER_API_KEY` or `OPENAI_API_KEY` in `.env`. For free OpenRouter testing, set `AI_PROVIDER=openrouter` and `AI_MODEL=openrouter/free`.
- Create a PayPal Sandbox business account and buyer account.
- Start the app from the repository root with `npm run dev` and confirm `/health` reports `sandbox`.
- Create a policy with a $50 per-transaction limit, $200 daily budget, USD currency, and an allowed Sandbox merchant email.
- Confirm the AI proposal panel labels its result **AI-Generated**, and note the configured provider/model for your disclosure.
- Reset to a clean database before the final rehearsal; keep a second recording attempt ready.

## Timed story

### 0:00–0:20 — Problem and product

Say: “AI agents can choose what to buy, but they should not decide how much they are allowed to spend. PayGuard turns each proposed purchase into a signed intent, checks deterministic rules, reserves budget, and only then reaches PayPal.”

Show the dashboard and the Sandbox provider label.

### 0:20–0:55 — AI request and policy decision

In Agent Activity, ask for a replacement keyboard under $30. Show the actual AI-generated proposal and its amount. Explain that AI proposes; it does not authorize.

Then ask for a $800 monitor. Show the amount remains $800 and the policy returns **DENY** because the limit is $50. Point to the Security Lab's “Provider NOT invoked” evidence for the corresponding over-limit scenario; clarify that the lab uses the simulator.

### 0:55–1:55 — PayPal Sandbox approval and capture

Use the allowed keyboard proposal. Show the signed intent and policy decision, then open the PayPal Sandbox approval link. Sign in with the Sandbox buyer, approve, return to Transactions, and click **Capture**. Show the final `SUCCEEDED` state and Sandbox provider label.

Do not claim a real-money payment; this is a PayPal Sandbox transaction.

### 1:55–2:35 — Verifiable controls

Show the audit timeline and run chain verification. If time permits, run the tampered-payload Security Lab scenario and show signature failure plus “Provider NOT invoked.” Identify the lab run as simulated.

### 2:35–2:45 — Close

Say: “PayGuard gives agents a path to propose purchases while keeping authorization deterministic, budgeted, and auditable.”

## Recording checklist

- Keep the final cut under 3 minutes and show the product operating on the desktop device.
- Record narration in English or add English captions.
- Use no copyrighted music or unlicensed third-party visuals/trademarks.
- Upload to YouTube with public visibility and add the URL to Devpost.
- Keep the app window, provider mode, policy decision, approval, capture, and audit result readable.

## Offline backup

If PayPal Sandbox credentials or network are unavailable, use `USE_SIMULATOR=true` and record the simulator flow as a development backup only. OpenRouter free models can also be rate-limited or temporarily unavailable. The submitted video still needs to demonstrate meaningful PayPal and AI use to satisfy the published requirements.
