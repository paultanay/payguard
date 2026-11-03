/**
 * Concurrency tests: multiple requests competing for the same budget.
 *
 * SQLite with BEGIN IMMEDIATE serializes writers — even when multiple
 * async operations are initiated simultaneously the database ensures
 * atomicity. These tests verify the invariant holds in a single process.
 *
 * Documented limitation: multi-process / multi-instance scenarios are
 * NOT guaranteed by this implementation.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../../src/db/connection.js';
import { PolicyEngine } from '../../src/policy/engine.js';
import { BudgetService } from '../../src/budget/service.js';
import { IntentService } from '../../src/intent/service.js';
import { PaymentSimulator } from '../../src/provider/simulator.js';
import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';

describe('Concurrent budget race conditions', () => {
  let db: Database.Database;
  let policyEngine: PolicyEngine;
  let budgetService: BudgetService;

  beforeEach(() => {
    db = createTestDb();
    policyEngine = new PolicyEngine(db);
    budgetService = new BudgetService(db);
  });

  it('INVARIANT: sum of successful reservations never exceeds budget limit', async () => {
    const BUDGET = 10000; // $100
    const AMOUNT_EACH = 3000; // $30
    const NUM_CONCURRENT = 10;

    const policy = policyEngine.createPolicy({
      owner_id: 'u', agent_id: `agent_${nanoid(6)}`,
      name: 'Race Test',
      max_amount_minor: AMOUNT_EACH,
      budget_limit_minor: BUDGET,
      currency: 'USD',
    });

    // Launch all reservations simultaneously (no real FK — intent IDs are arbitrary)
    const reservationPromises = Array.from({ length: NUM_CONCURRENT }, (_, i) =>
      Promise.resolve(budgetService.reserve(`intent_race_${i}`, policy.id, AMOUNT_EACH, 'USD'))
    );

    const results = await Promise.all(reservationPromises);

    const succeeded = results.filter((r) => r.success);
    const totalReserved = succeeded.reduce((sum, r) => sum + (r.reservation?.amount_minor ?? 0), 0);

    // INVARIANT: total reserved must not exceed budget
    expect(totalReserved).toBeLessThanOrEqual(BUDGET);

    // At most floor(10000/3000) = 3 can succeed
    expect(succeeded.length).toBeLessThanOrEqual(Math.floor(BUDGET / AMOUNT_EACH));

    // Remaining budget + total reserved = original budget
    const remaining = budgetService.getRemainingBudget(policy.id);
    expect(remaining + totalReserved).toBe(BUDGET);
  });

  it('INVARIANT holds with exact budget (no slack)', async () => {
    const BUDGET = 6000;
    const AMOUNT_EACH = 3000;

    const policy = policyEngine.createPolicy({
      owner_id: 'u', agent_id: `agent_${nanoid(6)}`,
      name: 'Exact Race Test',
      max_amount_minor: AMOUNT_EACH,
      budget_limit_minor: BUDGET,
      currency: 'USD',
    });

    const results = await Promise.all([
      Promise.resolve(budgetService.reserve('i1', policy.id, AMOUNT_EACH, 'USD')),
      Promise.resolve(budgetService.reserve('i2', policy.id, AMOUNT_EACH, 'USD')),
      Promise.resolve(budgetService.reserve('i3', policy.id, AMOUNT_EACH, 'USD')), // should fail
    ]);

    const succeeded = results.filter((r) => r.success).length;
    expect(succeeded).toBe(2); // exactly 2 fit
    expect(budgetService.getRemainingBudget(policy.id)).toBe(0);
  });

  it('full flow: concurrent payment execution respects budget', async () => {
    const BUDGET = 10000;
    const simulator = new PaymentSimulator();
    const intentService = new IntentService(db, simulator);

    const policy = policyEngine.createPolicy({
      owner_id: 'u', agent_id: 'race_agent',
      name: 'Full Race Test',
      max_amount_minor: 4000,
      budget_limit_minor: BUDGET,
      currency: 'USD',
    });

    // Create 5 intents of $40 each (total $200 vs $100 budget)
    const intents = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        intentService.createIntent({
          policy_id: policy.id, agent_id: 'race_agent',
          amount_minor: 4000, currency: 'USD',
          payee_id: 'merchant', description: `Race ${i}`,
          idempotency_key: `race_${nanoid(8)}`,
        })
      )
    );

    // Execute all simultaneously
    const execResults = await Promise.all(
      intents.map(({ intent, decision }) =>
        decision === 'ALLOW'
          ? intentService.executePayment({ intent_id: intent.id })
          : Promise.resolve({ success: false, state: 'DENIED', provider_mode: 'simulated' })
      )
    );

    const successful = execResults.filter((r) => r.success).length;

    // INVARIANT: at most floor(10000/4000) = 2 can succeed
    expect(successful).toBeLessThanOrEqual(2);

    // Remaining budget must be >= 0
    const remaining = policyEngine.getPolicyById(policy.id)!.remaining_budget_minor;
    expect(remaining).toBeGreaterThanOrEqual(0);
  });

  it('releasing failed reservations restores full budget', () => {
    const policy = policyEngine.createPolicy({
      owner_id: 'u', agent_id: `agent_${nanoid(6)}`,
      name: 'Release Test',
      max_amount_minor: 5000, budget_limit_minor: 5000, currency: 'USD',
    });

    // Reserve all budget
    const r = budgetService.reserve('i_release', policy.id, 5000, 'USD');
    expect(r.success).toBe(true);
    expect(budgetService.getRemainingBudget(policy.id)).toBe(0);

    // Release it
    budgetService.release(r.reservation!.id);
    expect(budgetService.getRemainingBudget(policy.id)).toBe(5000);

    // Can now reserve again
    const r2 = budgetService.reserve('i_release2', policy.id, 5000, 'USD');
    expect(r2.success).toBe(true);
  });
});
