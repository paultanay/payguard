/**
 * Security Lab — runs actual application logic, not scripted animations.
 * Each scenario calls real policy/transaction code.
 * Provider invocation status is reported honestly.
 */

import type Database from 'better-sqlite3';
import { PolicyEngine } from '../policy/engine.js';
import { IntentService } from '../intent/service.js';
import { AuditService } from '../audit/service.js';
import { PaymentSimulator } from '../provider/simulator.js';
import { nanoid } from 'nanoid';
import { sha256 } from '../crypto/hash.js';

export interface LabResult {
  scenario: string;
  description: string;
  policy_summary: string;
  input_summary: string;
  expected_result: string;
  actual_result: string;
  provider_invoked: boolean;
  provider_mode: string;
  passed: boolean;
  audit_events: string[];
  details: Record<string, unknown>;
}

export async function runLabScenario(
  scenario: string,
  db: Database.Database,
  policyId?: string,
): Promise<LabResult> {
  const policyEngine = new PolicyEngine(db);
  const auditService = new AuditService(db);
  const simulator = new PaymentSimulator();
  const intentService = new IntentService(db, simulator);

  // Get or create a test policy
  let policy = policyId ? policyEngine.getPolicyById(policyId) : null;
  if (!policy) {
    policy = policyEngine.createPolicy({
      owner_id: 'lab_user',
      agent_id: 'lab_agent',
      name: `Lab Policy ${nanoid(6)}`,
      allowed_operations: ['purchase'],
      allowed_payees: [],
      max_amount_minor: 5000,  // $50 max per transaction
      currency: 'USD',
      budget_period: 'daily',
      budget_limit_minor: 10000, // $100 daily budget
      require_approval: false,
    });
  }

  const agentId = policy.agent_id;
  let providerInvoked = false;

  switch (scenario) {

    case 'valid_payment': {
      const { intent, decision } = await intentService.createIntent({
        policy_id: policy.id,
        agent_id: agentId,
        amount_minor: 1999, // $19.99
        currency: 'USD',
        payee_id: 'merchant_demo',
        payee_name: 'Demo Merchant',
        description: 'Wireless keyboard purchase',
        idempotency_key: `lab_valid_${nanoid(8)}`,
      });

      let execResult = null;
      if (decision === 'ALLOW') {
        providerInvoked = true;
        execResult = await intentService.executePayment({ intent_id: intent.id });
        if (execResult.success) {
          await intentService.capturePayment(execResult.transaction_id!);
        }
      }

      const finalIntent = intentService.getIntent(intent.id);
      const events = auditService.getEvents({ entity_id: intent.id, limit: 10 });

      return {
        scenario, description: 'Valid payment within policy limits',
        policy_summary: `Max: $50/txn, $100 daily budget`,
        input_summary: '$19.99 purchase to demo merchant',
        expected_result: 'ALLOW → SUCCEEDED',
        actual_result: finalIntent?.state ?? decision,
        provider_invoked: providerInvoked,
        provider_mode: simulator.mode,
        passed: finalIntent?.state === 'SUCCEEDED',
        audit_events: events.map((e) => `${e.event_type}: ${e.entity_id.slice(0, 16)}`),
        details: { intent_id: intent.id, decision, exec_result: execResult },
      };
    }

    case 'exceed_per_transaction_limit': {
      const { intent, decision, reason } = await intentService.createIntent({
        policy_id: policy.id,
        agent_id: agentId,
        amount_minor: 7500, // $75 > $50 limit
        currency: 'USD',
        payee_id: 'merchant_demo',
        description: 'Over-limit purchase attempt',
        idempotency_key: `lab_overlimit_${nanoid(8)}`,
      });

      const events = auditService.getEvents({ entity_id: intent.id, limit: 5 });
      return {
        scenario, description: 'Amount exceeds per-transaction limit',
        policy_summary: `Max: $50/txn`,
        input_summary: '$75.00 purchase (over $50 limit)',
        expected_result: 'DENY — amount exceeds per-transaction limit',
        actual_result: `${decision}: ${reason}`,
        provider_invoked: false,
        provider_mode: simulator.mode,
        passed: decision === 'DENY',
        audit_events: events.map((e) => `${e.event_type}`),
        details: { intent_id: intent.id, decision, reason },
      };
    }

    case 'exhaust_budget': {
      // Use up most of the budget first
      const burnPolicy = policyEngine.createPolicy({
        owner_id: 'lab_user',
        agent_id: `lab_exhaust_${nanoid(6)}`,
        name: 'Exhaust Test Policy',
        allowed_operations: ['purchase'],
        allowed_payees: [],
        max_amount_minor: 8000,
        currency: 'USD',
        budget_period: 'daily',
        budget_limit_minor: 8000, // $80 total
        require_approval: false,
      });

      // First payment uses all $80
      const { intent: i1, decision: d1 } = await intentService.createIntent({
        policy_id: burnPolicy.id, agent_id: burnPolicy.agent_id,
        amount_minor: 7900, currency: 'USD', payee_id: 'merchant_demo',
        description: 'First big purchase',
        idempotency_key: `lab_exhaust1_${nanoid(8)}`,
      });
      if (d1 === 'ALLOW') {
        providerInvoked = true;
        const r = await intentService.executePayment({ intent_id: i1.id });
        if (r.success) await intentService.capturePayment(r.transaction_id!);
      }

      // Second payment should be denied (budget exhausted)
      const { intent: i2, decision: d2, reason: r2 } = await intentService.createIntent({
        policy_id: burnPolicy.id, agent_id: burnPolicy.agent_id,
        amount_minor: 500, currency: 'USD', payee_id: 'merchant_demo',
        description: 'Second purchase — should be denied',
        idempotency_key: `lab_exhaust2_${nanoid(8)}`,
      });

      return {
        scenario, description: 'Aggregate budget exhausted — second payment denied',
        policy_summary: '$80 daily budget',
        input_summary: '$79 + $5 = $84 attempted (over $80 budget)',
        expected_result: 'Second payment DENY — budget exhausted',
        actual_result: `${d2}: ${r2}`,
        provider_invoked: providerInvoked,
        provider_mode: simulator.mode,
        passed: d2 === 'DENY',
        audit_events: [],
        details: { first_decision: d1, second_decision: d2, reason: r2 },
      };
    }

    case 'unauthorized_payee': {
      const restrictedPolicy = policyEngine.createPolicy({
        owner_id: 'lab_user',
        agent_id: `lab_payee_${nanoid(6)}`,
        name: 'Restricted Payee Policy',
        allowed_operations: ['purchase'],
        allowed_payees: ['approved_merchant_only'],
        max_amount_minor: 5000, currency: 'USD',
        budget_period: 'daily', budget_limit_minor: 10000,
        require_approval: false,
      });

      const { decision, reason } = await intentService.createIntent({
        policy_id: restrictedPolicy.id,
        agent_id: restrictedPolicy.agent_id,
        amount_minor: 1000, currency: 'USD',
        payee_id: 'unauthorized_merchant', // not in allowed list
        description: 'Purchase from unauthorized merchant',
        idempotency_key: `lab_payee_${nanoid(8)}`,
      });

      return {
        scenario, description: 'Unauthorized payee — merchant not in allowed list',
        policy_summary: 'Only allows payee: approved_merchant_only',
        input_summary: 'Purchase from unauthorized_merchant',
        expected_result: 'DENY — payee not authorized',
        actual_result: `${decision}: ${reason}`,
        provider_invoked: false,
        provider_mode: simulator.mode,
        passed: decision === 'DENY',
        audit_events: [],
        details: { decision, reason },
      };
    }

    case 'expired_intent': {
      // Create intent with minimum TTL then immediately backdate expires_at
      const { intent, decision } = await intentService.createIntent({
        policy_id: policy.id, agent_id: agentId,
        amount_minor: 500, currency: 'USD',
        payee_id: 'merchant_demo', description: 'Intent that will expire',
        idempotency_key: `lab_expire_${nanoid(8)}`,
        ttl_seconds: 1,
      });

      // Immediately backdate to force expiry
      db.prepare('UPDATE payment_intents SET expires_at = ? WHERE id = ?')
        .run(new Date(Date.now() - 5000).toISOString(), intent.id);

      const execResult = await intentService.executePayment({ intent_id: intent.id });

      return {
        scenario, description: 'Expired intent rejected before payment execution',
        policy_summary: 'Standard policy',
        input_summary: 'Intent with 0-second TTL',
        expected_result: 'EXPIRED — intent rejected before provider call',
        actual_result: execResult.state,
        provider_invoked: execResult.state !== 'EXPIRED',
        provider_mode: simulator.mode,
        passed: execResult.state === 'EXPIRED' && !execResult.success,
        audit_events: [],
        details: { intent_id: intent.id, initial_decision: decision, exec_result: execResult },
      };
    }

    case 'replay_attack': {
      // Execute a valid intent to completion
      const { intent, decision } = await intentService.createIntent({
        policy_id: policy.id, agent_id: agentId,
        amount_minor: 500, currency: 'USD',
        payee_id: 'merchant_demo', description: 'Original valid purchase',
        idempotency_key: `lab_replay_${nanoid(8)}`,
      });

      let firstResult = null;
      if (decision === 'ALLOW') {
        providerInvoked = true;
        const r = await intentService.executePayment({ intent_id: intent.id });
        if (r.success) { firstResult = await intentService.capturePayment(r.transaction_id!); }
      }

      // Attempt replay — execute the same intent again
      const replayResult = await intentService.executePayment({ intent_id: intent.id });

      return {
        scenario, description: 'Replay attack — attempting to re-execute a succeeded intent',
        policy_summary: 'Standard policy',
        input_summary: 'Same intent executed twice',
        expected_result: 'First: SUCCEEDED; Second: REPLAY rejected',
        actual_result: `First: ${firstResult?.state ?? decision}; Second: ${replayResult.state}`,
        provider_invoked: providerInvoked,
        provider_mode: simulator.mode,
        passed: !replayResult.success && replayResult.state === 'REPLAY',
        audit_events: [],
        details: { first_result: firstResult, replay_result: replayResult },
      };
    }

    case 'tampered_payload': {
      const { intent } = await intentService.createIntent({
        policy_id: policy.id, agent_id: agentId,
        amount_minor: 500, currency: 'USD',
        payee_id: 'merchant_demo', description: 'Original purchase',
        idempotency_key: `lab_tamper_${nanoid(8)}`,
      });

      // Tamper with the amount in the database
      db.prepare('UPDATE payment_intents SET amount_minor = 9999999 WHERE id = ?').run(intent.id);

      // Try to execute — signature verification should fail
      const execResult = await intentService.executePayment({ intent_id: intent.id });

      return {
        scenario, description: 'Tampered payload — amount modified in database',
        policy_summary: 'Standard policy',
        input_summary: 'Intent signed for $5.00, amount tampered to $99,999.99',
        expected_result: 'FAILED — signature verification detects tampering',
        actual_result: execResult.state + (execResult.error ? `: ${execResult.error}` : ''),
        provider_invoked: false,
        provider_mode: simulator.mode,
        passed: !execResult.success && (execResult.error ?? '').toLowerCase().includes('signature'),
        audit_events: [],
        details: { intent_id: intent.id, tampered_amount: 9999999, exec_result: execResult },
      };
    }

    case 'budget_race': {
      // This scenario is better tested in concurrency tests.
      // Here we demonstrate the atomic reservation concept.
      const racePolicy = policyEngine.createPolicy({
        owner_id: 'lab_user',
        agent_id: `lab_race_${nanoid(6)}`,
        name: 'Race Test Policy',
        allowed_operations: ['purchase'],
        allowed_payees: [],
        max_amount_minor: 6000, currency: 'USD',
        budget_period: 'daily',
        budget_limit_minor: 10000, // $100
        require_approval: false,
      });

      // Create 3 intents each for $40 (total $120 > $100 budget)
      const intents = await Promise.all([
        intentService.createIntent({
          policy_id: racePolicy.id, agent_id: racePolicy.agent_id,
          amount_minor: 4000, currency: 'USD', payee_id: 'merchant_demo',
          description: `Race intent 1`, idempotency_key: `lab_race1_${nanoid(8)}`,
        }),
        intentService.createIntent({
          policy_id: racePolicy.id, agent_id: racePolicy.agent_id,
          amount_minor: 4000, currency: 'USD', payee_id: 'merchant_demo',
          description: `Race intent 2`, idempotency_key: `lab_race2_${nanoid(8)}`,
        }),
        intentService.createIntent({
          policy_id: racePolicy.id, agent_id: racePolicy.agent_id,
          amount_minor: 4000, currency: 'USD', payee_id: 'merchant_demo',
          description: `Race intent 3`, idempotency_key: `lab_race3_${nanoid(8)}`,
        }),
      ]);

      // Execute all three simultaneously (SQLite serializes these)
      const results = await Promise.allSettled(
        intents.map(({ intent, decision }) =>
          decision === 'ALLOW' ? intentService.executePayment({ intent_id: intent.id }) : Promise.resolve({ success: false, state: 'DENIED', provider_mode: simulator.mode })
        )
      );

      const succeeded = results.filter((r) => r.status === 'fulfilled' && (r as PromiseFulfilledResult<{ success: boolean }>).value.success).length;
      const failed = results.length - succeeded;

      return {
        scenario, description: 'Budget race — 3×$40 against $100 budget (only 2 should succeed)',
        policy_summary: '$100 daily budget, $60 max per transaction',
        input_summary: '3 simultaneous $40 payment attempts',
        expected_result: 'At most 2 succeed, at least 1 denied (budget constraint)',
        actual_result: `${succeeded} succeeded, ${failed} failed`,
        provider_invoked: succeeded > 0,
        provider_mode: simulator.mode,
        passed: succeeded <= 2 && failed >= 1,
        audit_events: [],
        details: { succeeded, failed, results: results.map((r) => r.status === 'fulfilled' ? (r as PromiseFulfilledResult<{ state: string }>).value.state : 'error') },
      };
    }

    case 'malicious_ai_output': {
      // Simulate AI trying to override policy denial
      // The AI output is validated with Zod — malformed output is rejected
      const invalidProposal = '{"item_name": "exploit", "budget_override": 999999, "estimated_amount_minor": -1}';

      let parseError = null;
      try {
        const { PurchaseProposalSchema } = await import('../ai/adapter.js');
        PurchaseProposalSchema.parse(JSON.parse(invalidProposal));
      } catch (err) {
        parseError = err instanceof Error ? err.message : String(err);
      }

      return {
        scenario, description: 'Malicious AI output — attempting budget override and negative amount',
        policy_summary: 'Standard policy',
        input_summary: 'AI output with budget_override field and negative amount',
        expected_result: 'Schema validation rejects malformed AI output',
        actual_result: parseError ? `Rejected: ${parseError.slice(0, 200)}` : 'UNEXPECTED: validation passed',
        provider_invoked: false,
        provider_mode: simulator.mode,
        passed: !!parseError,
        audit_events: [],
        details: { invalid_output: invalidProposal, parse_error: parseError },
      };
    }

    case 'provider_timeout': {
      simulator.setBehavior('timeout');
      const { intent, decision } = await intentService.createIntent({
        policy_id: policy.id, agent_id: agentId,
        amount_minor: 1000, currency: 'USD',
        payee_id: 'merchant_demo', description: 'Timeout test purchase',
        idempotency_key: `lab_timeout_${nanoid(8)}`,
      });

      let execResult = null;
      if (decision === 'ALLOW') {
        providerInvoked = true;
        execResult = await intentService.executePayment({ intent_id: intent.id });
      }
      simulator.setBehavior('succeed'); // reset

      return {
        scenario, description: 'Provider timeout — outcome unknown, reservation preserved',
        policy_summary: 'Standard policy',
        input_summary: '$10.00 purchase — provider times out',
        expected_result: 'RECONCILIATION_REQUIRED — budget NOT released, manual check needed',
        actual_result: execResult?.state ?? 'not_executed',
        provider_invoked: providerInvoked,
        provider_mode: simulator.mode,
        passed: execResult?.state === 'RECONCILIATION_REQUIRED',
        audit_events: [],
        details: { intent_id: intent.id, exec_result: execResult },
      };
    }

    case 'tampered_audit': {
      // Record a legitimate event, then tamper with it
      auditService.record('PAYMENT_STATE_CHANGED', 'test_entity', 'transaction', {
        from: 'RESERVED', to: 'SUCCEEDED', amount_minor: 1000,
      }, 'gateway');

      const events = auditService.getEvents({ entity_id: 'test_entity', limit: 1 });
      const event = events[0];

      // Tamper: modify the amount in the metadata
      if (event) {
        db.prepare('UPDATE audit_events SET metadata = ? WHERE id = ?')
          .run(JSON.stringify({ from: 'RESERVED', to: 'SUCCEEDED', amount_minor: 999999 }), event.id);
      }

      const verification = auditService.verify();

      return {
        scenario, description: 'Tampered audit record — modifying event metadata',
        policy_summary: 'N/A',
        input_summary: 'Audit event amount changed from $10 to $9,999.99',
        expected_result: 'Audit chain verification detects tampering',
        actual_result: verification.valid ? 'UNEXPECTED: verification passed' : `Detected: ${verification.errors.join('; ')}`,
        provider_invoked: false,
        provider_mode: simulator.mode,
        passed: !verification.valid,
        audit_events: [],
        details: { verification },
      };
    }

    case 'malformed_ai_output': {
      const malformedOutputs = [
        'not json at all',
        '{"estimated_amount_minor": "not_a_number"}',
        '{"currency": "TOOLONG"}',
        null,
        '{"confidence": 2.0}',  // > 1.0
      ];

      const { PurchaseProposalSchema } = await import('../ai/adapter.js');
      const results = malformedOutputs.map((output) => {
        try {
          PurchaseProposalSchema.parse(typeof output === 'string' ? JSON.parse(output) : output);
          return 'UNEXPECTED: passed';
        } catch {
          return 'rejected';
        }
      });

      const allRejected = results.every((r) => r === 'rejected');
      return {
        scenario, description: 'Malformed AI output — various invalid schemas',
        policy_summary: 'N/A',
        input_summary: '5 malformed AI output formats',
        expected_result: 'All 5 rejected by schema validation',
        actual_result: `${results.filter(r => r === 'rejected').length}/5 rejected`,
        provider_invoked: false,
        provider_mode: simulator.mode,
        passed: allRejected,
        audit_events: [],
        details: { results },
      };
    }

    default:
      return {
        scenario, description: 'Unknown scenario',
        policy_summary: '', input_summary: '',
        expected_result: '', actual_result: 'Scenario not implemented',
        provider_invoked: false, provider_mode: simulator.mode,
        passed: false, audit_events: [], details: {},
      };
  }
}
