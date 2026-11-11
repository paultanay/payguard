import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../../src/db/connection.js';
import { PolicyEngine } from '../../src/policy/engine.js';
import { BudgetService } from '../../src/budget/service.js';
import { nanoid } from 'nanoid';
import type Database from 'better-sqlite3';

describe('BudgetService — atomic reservations', () => {
  let db: Database.Database;
  let policyEngine: PolicyEngine;
  let budgetService: BudgetService;

  beforeEach(() => {
    db = createTestDb();
    policyEngine = new PolicyEngine(db);
    budgetService = new BudgetService(db);
  });

  function makePolicy(budgetLimit: number, maxPerTxn?: number) {
    return policyEngine.createPolicy({
      owner_id: 'user', agent_id: `agent_${nanoid(6)}`,
      name: 'Budget Test',
      max_amount_minor: maxPerTxn ?? budgetLimit,
      budget_limit_minor: budgetLimit,
      currency: 'USD',
    });
  }

  it('reserves budget atomically', () => {
    const policy = makePolicy(10000);
    const result = budgetService.reserve('int_1', policy.id, 3000, 'USD');
    expect(result.success).toBe(true);
    expect(result.reservation?.amount_minor).toBe(3000);
    expect(result.reservation?.status).toBe('reserved');
    expect(budgetService.getRemainingBudget(policy.id)).toBe(7000);
  });

  it('fails when amount exceeds remaining budget', () => {
    const policy = makePolicy(5000);
    const result = budgetService.reserve('int_1', policy.id, 6000, 'USD');
    expect(result.success).toBe(false);
    expect(result.reason).toContain('Insufficient');
    expect(budgetService.getRemainingBudget(policy.id)).toBe(5000); // unchanged
  });

  it('two sequential reservations within budget both succeed', () => {
    const policy = makePolicy(10000);
    const r1 = budgetService.reserve('int_1', policy.id, 3000, 'USD');
    const r2 = budgetService.reserve('int_2', policy.id, 3000, 'USD');
    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(budgetService.getRemainingBudget(policy.id)).toBe(4000);
  });

  it('third reservation fails when budget exhausted', () => {
    const policy = makePolicy(10000);
    budgetService.reserve('int_1', policy.id, 4000, 'USD');
    budgetService.reserve('int_2', policy.id, 4000, 'USD');
    const r3 = budgetService.reserve('int_3', policy.id, 3000, 'USD'); // 8000+3000 > 10000
    expect(r3.success).toBe(false);
    expect(budgetService.getRemainingBudget(policy.id)).toBe(2000);
  });

  it('releasing a reservation restores budget', () => {
    const policy = makePolicy(10000);
    const r = budgetService.reserve('int_1', policy.id, 5000, 'USD');
    expect(r.success).toBe(true);
    budgetService.release(r.reservation!.id);
    expect(budgetService.getRemainingBudget(policy.id)).toBe(10000);
  });

  it('does not credit a prior-period reservation to the current budget', () => {
    const policy = makePolicy(10000);
    const result = budgetService.reserve('int_previous_period', policy.id, 3000, 'USD');
    db.prepare('UPDATE budget_reservations SET period_key = ? WHERE id = ?')
      .run('previous-period', result.reservation!.id);
    db.prepare('UPDATE policies SET remaining_budget_minor = 4000 WHERE id = ?').run(policy.id);

    expect(budgetService.release(result.reservation!.id)).toBe(true);
    expect(budgetService.getRemainingBudget(policy.id)).toBe(4000);
  });

  it('consuming a reservation does not restore budget', () => {
    const policy = makePolicy(10000);
    const r = budgetService.reserve('int_1', policy.id, 5000, 'USD');
    budgetService.consume(r.reservation!.id, 'txn_1');
    expect(budgetService.getRemainingBudget(policy.id)).toBe(5000); // budget stays reduced
  });

  it('cannot release an already consumed reservation', () => {
    const policy = makePolicy(10000);
    const r = budgetService.reserve('int_1', policy.id, 5000, 'USD');
    budgetService.consume(r.reservation!.id, 'txn_1');
    const released = budgetService.release(r.reservation!.id);
    expect(released).toBe(false); // already consumed
  });

  it('currency mismatch fails reservation', () => {
    const policy = makePolicy(10000);
    const result = budgetService.reserve('int_1', policy.id, 1000, 'EUR');
    expect(result.success).toBe(false);
    expect(result.reason).toContain('Currency mismatch');
  });

  describe('budget invariant under sequential rapid requests', () => {
    it('enforces budget invariant across rapid sequential requests', () => {
      const policy = makePolicy(10000, 3000); // $100 budget, $30 max per txn
      const results = Array.from({ length: 5 }, (_, i) =>
        budgetService.reserve(`int_${i}`, policy.id, 3000, 'USD') // 3 × $30 = $90, 4th fails
      );

      const succeeded = results.filter((r) => r.success).length;
      const total = results.filter((r) => r.success).reduce((sum, r) => sum + (r.reservation?.amount_minor ?? 0), 0);

      // At most floor(10000/3000) = 3 can succeed
      expect(succeeded).toBe(3);
      expect(total).toBe(9000);
      expect(budgetService.getRemainingBudget(policy.id)).toBe(1000);
    });
  });
});
