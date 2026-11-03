# PayGuard — Demo Script

**Target audience**: Hackathon judges  
**Duration**: ~3 minutes  
**Mode**: Simulated (no PayPal credentials needed for demo)

---

## Required Environment

```bash
# Terminal 1: Backend
cd packages/backend
USE_SIMULATOR=true npx tsx src/server.ts

# Terminal 2: Frontend (optional, demo can be done via API too)
cd packages/frontend
npx vite --port 5173
```

Dashboard: http://localhost:5173  
API: http://localhost:3001

---

## Demo Reset

Run this before each demo to get a clean state:

```bash
# Stop server, delete DB, restart
rm -f data/payguard.db
# Restart backend
```

---

## Demo Sequence (3 minutes)

### Minute 1: Setup + Valid Payment

**Step 1 — Show the concept (15 sec)**  
Open dashboard → Overview. Point out:
- Provider mode: SIMULATED (clearly labeled)
- No hardcoded values — all totals come from the database

**Step 2 — Create a spending policy (30 sec)**  
Dashboard → Policies → Create Policy:
```
Agent ID: ai_shopping_agent
Name: Shopping Budget
Max per transaction: 5000 (= $50.00)
Daily budget limit: 20000 (= $200.00)
Require approval: No
```
→ Policy created. Show the remaining budget counter.

**Step 3 — AI generates a purchase proposal (30 sec)**  
Dashboard → Agent Activity → type in the text box:
> "Buy a replacement mechanical keyboard under $30"

Click "Generate Proposal" → AI (or deterministic fallback) returns:
- Item: mechanical keyboard
- Amount: ~$2999 ($29.99)
- Category: electronics
- Confidence shown

**Step 4 — Execute the payment (15 sec)**  
Click "Create Intent & Execute" → watch it go:
- Policy evaluates → ALLOW
- Budget reserved atomically: $200 → $170.01
- Provider (SIMULATED) called → SUCCEEDED
- Semantic check: ✅ Intent matches proposal

Show: Overview updates in real-time. Transaction appears in Transactions tab with state SUCCEEDED.

---

### Minute 2: Rejected Payments + Security

**Step 5 — Over-budget rejection (20 sec)**  
Agent Activity → request:
> "Buy a 4K monitor for $800"

System evaluates → DENY: Amount 80000 exceeds per-transaction limit 5000  
Point out: **Provider was never called** (provider_invoked: false)

**Step 6 — Unauthorized payee (20 sec)**  
Create a new policy with `allowed_payees: approved_merchant_only`, then try to pay `evil_merchant`:
→ DENY: Payee not in allowed list. Provider not called.

**Step 7 — Run the tampered payload attack (30 sec)**  
Security Lab → click "Tampered Payload":
```
Input: Intent signed for $5.00, amount modified to $99,999.99 in database
Expected: Signature verification fails
Actual: FAILED — Signature invalid: Canonical hash mismatch
Provider invoked: NO
```

This demonstrates Ed25519 signing over all security fields.

---

### Minute 3: Concurrency + Audit

**Step 8 — Budget race attack (30 sec)**  
Security Lab → click "Budget Race":
```
3×$40 against a $100 budget, executed simultaneously
Expected: At most 2 succeed
Actual: 2 succeeded, 1 failed — $80 spent, $20 remaining
```

This is the core differentiator — the atomic `UPDATE … WHERE remaining >= amount` prevents all over-spend even under concurrent load.

**Step 9 — Audit chain + tamper detection (30 sec)**  
Security Lab → click "Tampered Audit Record":
```
Audit event amount modified from $10 to $9,999.99 in database
Expected: Verification detects tampering
Actual: Detected: Event #N: hash mismatch — event has been tampered with
```

Then Dashboard → Audit → click "Verify Chain Integrity":
- Shows all events with sequence numbers and hash fingerprints
- "Verification" result shown after manual tampering test

**Step 10 — Wrap up (30 sec)**  
Show: Overview again with all real totals from persisted DB.  
Point to: SIMULATED label (clearly present throughout).  
Say: "With PayPal credentials set, this exact same flow executes against PayPal Sandbox. The authorization layer is independent of the payment provider."

---

## Known Demo Risks

| Risk | Mitigation |
|---|---|
| Server not started | Pre-start before demo, verify `/health` |
| DB in bad state from previous demo | Run reset script |
| AI proposal fails (no API key) | Deterministic fallback still works, label shown |
| Port conflict on 3001/5173 | Use `PORT=3002` env var if needed |

---

## Offline Backup Flow

If everything fails, show via curl:
```bash
# Create policy
curl -X POST http://localhost:3001/api/policies \
  -H "Content-Type: application/json" \
  -d '{"owner_id":"demo","agent_id":"agent_1","name":"Demo","max_amount_minor":5000,"budget_limit_minor":20000}'

# Create + execute intent
curl -X POST http://localhost:3001/api/intents \
  -H "Content-Type: application/json" \
  -d '{"policy_id":"POLICY_ID","agent_id":"agent_1","amount_minor":1999,"currency":"USD","payee_id":"shop","description":"keyboard"}'

# Verify audit chain
curl -X POST http://localhost:3001/api/audit/verify
```

---

## What Is Real vs Simulated

| Component | Status |
|---|---|
| Policy engine evaluation | ✅ Real — deterministic, no LLM |
| Ed25519 intent signing | ✅ Real — @noble/ed25519 |
| Atomic budget reservation | ✅ Real — SQLite BEGIN IMMEDIATE |
| Audit hash chain | ✅ Real — SHA-256 chain |
| Payment provider | ⚠️ SIMULATED (label always shown) |
| AI proposals | ✅ Real (if OPENAI_API_KEY set) or labeled deterministic fallback |
| PayPal Sandbox | ✅ Real (if credentials set) |
