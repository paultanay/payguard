import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../../src/db/connection.js';
import { PolicyEngine } from '../../src/policy/engine.js';
import { IntentService } from '../../src/intent/service.js';
import { PaymentSimulator } from '../../src/provider/simulator.js';
import { AuditService } from '../../src/audit/service.js';
import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';

describe('Payment Flow Integration', () => {
  let db: Database.Database;
  let policyEngine: PolicyEngine;
  let simulator: PaymentSimulator;
  let intentService: IntentService;
  let audit: AuditService;
  let policyId: string;

  beforeEach(async () => {
    db = createTestDb();
    policyEngine = new PolicyEngine(db);
    simulator = new PaymentSimulator();
    intentService = new IntentService(db, simulator);
    audit = new AuditService(db);

    const policy = policyEngine.createPolicy({
      owner_id: 'user1', agent_id: 'test_agent',
      name: 'Integration Test Policy',
      max_amount_minor: 5000, budget_limit_minor: 20000, currency: 'USD',
    });
    policyId = policy.id;
  });

  it('complete successful payment flow', async () => {
    // 1. Create intent
    const { intent, decision } = await intentService.createIntent({
      policy_id: policyId, agent_id: 'test_agent',
      amount_minor: 1999, currency: 'USD',
      payee_id: 'merchant_demo', description: 'Keyboard purchase',
      idempotency_key: `idem_${nanoid(8)}`,
    });

    expect(decision).toBe('ALLOW');
    expect(intent.id).toMatch(/^int_/);

    // 2. Execute payment
    const execResult = await intentService.executePayment({ intent_id: intent.id });
    expect(execResult.success).toBe(true);
    expect(execResult.state).toBe('PAYMENT_PENDING');
    expect(execResult.transaction_id).toBeDefined();

    // 3. Capture
    const captureResult = await intentService.capturePayment(execResult.transaction_id!);
    expect(captureResult.success).toBe(true);
    expect(captureResult.state).toBe('SUCCEEDED');

    // 4. Verify final intent state
    const finalIntent = intentService.getIntent(intent.id);
    expect(finalIntent?.state).toBe('SUCCEEDED');

    // 5. Verify audit trail
    const events = audit.getEvents({ entity_id: intent.id });
    const eventTypes = events.map((e) => e.event_type);
    expect(eventTypes).toContain('INTENT_CREATED');
    expect(eventTypes).toContain('POLICY_EVALUATED');
    expect(eventTypes).toContain('BUDGET_RESERVED');
    expect(eventTypes).toContain('SIGNATURE_VERIFIED');
    expect(eventTypes).toContain('PROVIDER_REQUEST');
    expect(eventTypes).toContain('PROVIDER_RESPONSE');

    // 6. Audit chain intact
    const verification = audit.verify();
    expect(verification.valid).toBe(true);
  });

  it('replay is rejected after success', async () => {
    const { intent } = await intentService.createIntent({
      policy_id: policyId, agent_id: 'test_agent',
      amount_minor: 500, currency: 'USD',
      payee_id: 'merchant', description: 'test',
      idempotency_key: `idem_${nanoid(8)}`,
    });

    const r = await intentService.executePayment({ intent_id: intent.id });
    await intentService.capturePayment(r.transaction_id!);

    // Attempt replay
    const replay = await intentService.executePayment({ intent_id: intent.id });
    expect(replay.success).toBe(false);
    expect(replay.state).toBe('REPLAY');
  });

  it('over-limit amount is denied without touching provider', async () => {
    const { decision, reason } = await intentService.createIntent({
      policy_id: policyId, agent_id: 'test_agent',
      amount_minor: 9999, // > $50 limit
      currency: 'USD', payee_id: 'merchant', description: 'over limit',
      idempotency_key: `idem_${nanoid(8)}`,
    });

    expect(decision).toBe('DENY');
    expect(reason).toContain('per-transaction limit');
  });

  it('expired intent is rejected before provider call', async () => {
    const { intent } = await intentService.createIntent({
      policy_id: policyId, agent_id: 'test_agent',
      amount_minor: 500, currency: 'USD',
      payee_id: 'merchant', description: 'expire test',
      idempotency_key: `idem_${nanoid(8)}`,
    });

    // Force expiry
    db.prepare('UPDATE payment_intents SET expires_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 1000).toISOString(), intent.id);

    const result = await intentService.executePayment({ intent_id: intent.id });
    expect(result.success).toBe(false);
    expect(result.state).toBe('EXPIRED');
  });

  it('provider timeout enters reconciliation state without releasing budget', async () => {
    simulator.setBehavior('timeout');

    const { intent } = await intentService.createIntent({
      policy_id: policyId, agent_id: 'test_agent',
      amount_minor: 1000, currency: 'USD',
      payee_id: 'merchant', description: 'timeout test',
      idempotency_key: `idem_${nanoid(8)}`,
    });

    const result = await intentService.executePayment({ intent_id: intent.id });
    expect(result.state).toBe('RECONCILIATION_REQUIRED');

    // Budget must NOT be released (provider may have succeeded)
    const policy = policyEngine.getPolicyById(policyId)!;
    expect(policy.remaining_budget_minor).toBe(19000); // 20000 - 1000 reserved but not released
    simulator.setBehavior('succeed');
  });

  it('tampered intent signature fails verification', async () => {
    const { intent } = await intentService.createIntent({
      policy_id: policyId, agent_id: 'test_agent',
      amount_minor: 500, currency: 'USD',
      payee_id: 'merchant', description: 'test',
      idempotency_key: `idem_${nanoid(8)}`,
    });

    // Tamper with amount in DB
    db.prepare('UPDATE payment_intents SET amount_minor = 999999 WHERE id = ?').run(intent.id);

    const result = await intentService.executePayment({ intent_id: intent.id });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Signature');
  });

  it('idempotency: same key returns same intent', async () => {
    const idemKey = `idem_${nanoid(8)}`;
    const r1 = await intentService.createIntent({
      policy_id: policyId, agent_id: 'test_agent',
      amount_minor: 500, currency: 'USD',
      payee_id: 'merchant', description: 'test',
      idempotency_key: idemKey,
    });
    const r2 = await intentService.createIntent({
      policy_id: policyId, agent_id: 'test_agent',
      amount_minor: 500, currency: 'USD',
      payee_id: 'merchant', description: 'test',
      idempotency_key: idemKey,
    });

    expect(r1.intent.id).toBe(r2.intent.id);
    expect(r2.idempotent).toBe(true);
  });
});
