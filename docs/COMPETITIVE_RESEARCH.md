# PayGuard — Competitive Review

**Reviewed:** 2026-11-07
**Scope:** Public Devpost project descriptions for the PayPal AI Hackathon. Claims below summarize what entrants report; they are not independent audits of their code or demos. Entries can change before the deadline.

## Market Read

The broad concept—an AI payment agent behind deterministic spend controls, human approval, PayPal Sandbox, and an audit log—is crowded. PayGuard should not claim to be the only secure payment gateway, the only MCP payment guard, or the only project with atomic budgets or signed records.

### Closest public entries

- [SpendGuard](https://devpost.com/software/spendguard) describes PayPal Orders v2 Sandbox checkout, per-order/day/merchant rules, human approval, a circuit breaker, an AI planner, atomic reservations, and 62 tests. Its page says the public walkthrough was verified through order creation and the early-capture refusal, but the buyer approval page itself was not driven. This is a direct competitor.
- [agent-spend-guard](https://devpost.com/software/agent-spend-guard) describes a PayPal Vault mandate, Orders and Payments APIs, refunds, MCP tool access, a risk reviewer for prompt injection and price anomalies, and a hosted multi-scenario demo. It is a direct and broader competitor.
- [AgentGuard](https://devpost.com/software/agentguard-ar4blu) describes an MCP-connected PayPal guard, prompt-injection defense, approvals, anomaly analysis, a hosted dashboard, and a larger test suite.
- [PayPal AgentOps](https://devpost.com/software/paypal-agentops-control-plane-for-trusted-ai-commerce) describes a similar AI proposal, policy decision, human approval, and PayPal Sandbox flow.

These public descriptions show that policy gating, approvals, AI review, MCP, sandbox payments, and audit trails are not enough on their own to make PayGuard novel.

## PayGuard's Defensible Angle

The most specific story supported by this repository is a **verifiable authorization record**:

1. Ed25519 signatures bind the intent fields that matter to authorization.
2. Nonce, expiry, and idempotency checks make replay behavior explicit.
3. Budget reservation is atomic within the documented single-process SQLite boundary.
4. `.paytrace` exports can be verified offline for event hashes and chain linkage.

Do not imply that `.paytrace` proves who created the evidence or that a payment actually settled. It is a project-specific, hash-checked bundle without an external signing authority. A fresh chain can be constructed by an attacker with database and signing-key access.

## Submission Implications

- Lead with the exact authorization details cryptographically bound to a payment, then show the offline-verifiable evidence bundle.
- Show the model produce a real proposal, and show deterministic policy deny an over-limit proposal without contacting PayPal.
- Show the buyer approval step and subsequent capture in PayPal Sandbox. The simulator is not sufficient evidence of PayPal integration.
- Explain that PayGuard is a local authorization component for agents or MCP clients, not an autonomous shopping agent.
- Avoid superiority claims. Compare only specific behavior you can demonstrate and distinguish tested behavior from design intent.
- State precisely which runtime AI provider/model was used, and separately disclose coding-assistant use when the submission asks about AI tools.

## Remaining Evidence Gap

At this review, the workspace had no configured Sandbox credentials or OpenAI key. Thus the PayPal adapter and AI calls compile, but their end-to-end behavior remains unverified here. This gap is more important than adding another dashboard feature.
