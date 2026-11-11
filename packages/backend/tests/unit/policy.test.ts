import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../../src/db/connection.js';
import { PolicyEngine } from '../../src/policy/engine.js';
import { BudgetService } from '../../src/budget/service.js';
import { computePeriodKey } from '../../src/policy/model.js';
import type Database from 'better-sqlite3';

describe('PolicyEngine', () => {
  let db: Database.Database;
  let engine: PolicyEngine;

  beforeEach(() => {
    db = createTestDb();
    engine = new PolicyEngine(db);
  });

  describe('createPolicy', () => {
    it('creates a policy with correct defaults', () => {
      const policy = engine.createPolicy({
        owner_id: 'user1',
        agent_id: 'agent1',
        name: 'Test Policy',
        max_amount_minor: 5000,
        budget_limit_minor: 10000,
      });
      expect(policy.id).toMatch(/^pol_/);
      expect(policy.status).toBe('active');
      expect(policy.currency).toBe('USD');
      expect(policy.remaining_budget_minor).toBe(10000);
      expect(policy.version).toBe(1);
    });

    it('rejects negative amount', () => {
      expect(() =>
        engine.createPolicy({
          owner_id: 'u', agent_id: 'a', name: 'n',
          max_amount_minor: -1, budget_limit_minor: 100,
        })
      ).toThrow();
    });
  });

  it('preserves committed and reserved spend when the budget limit changes', () => {
    const policy = engine.createPolicy({
      owner_id: 'user1', agent_id: 'agent1', name: 'Budget update',
      max_amount_minor: 5000, budget_limit_minor: 10000,
    });
    new BudgetService(db).reserve('int_reserved', policy.id, 3000, 'USD');

    const updated = engine.updatePolicy(policy.id, { budget_limit_minor: 20000 });

    expect(updated?.remaining_budget_minor).toBe(17000);
  });

  describe('evaluate - DENY cases', () => {
    let policyId: string;

    beforeEach(() => {
      const p = engine.createPolicy({
        owner_id: 'user1', agent_id: 'agent1', name: 'Test',
        max_amount_minor: 5000, budget_limit_minor: 10000,
        allowed_payees: ['merchant_a'],
      });
      policyId = p.id;
    });

    it('denies when policy not found', () => {
      const result = engine.evaluate({
        policy_id: 'nonexistent', agent_id: 'agent1',
        operation: 'purchase', amount_minor: 100, currency: 'USD', payee_id: 'merchant_a',
      });
      expect(result.decision).toBe('DENY');
    });

    it('denies when agent ID mismatch', () => {
      const result = engine.evaluate({
        policy_id: policyId, agent_id: 'wrong_agent',
        operation: 'purchase', amount_minor: 100, currency: 'USD', payee_id: 'merchant_a',
      });
      expect(result.decision).toBe('DENY');
    });

    it('denies when amount exceeds per-transaction limit', () => {
      const result = engine.evaluate({
        policy_id: policyId, agent_id: 'agent1',
        operation: 'purchase', amount_minor: 6000, currency: 'USD', payee_id: 'merchant_a',
      });
      expect(result.decision).toBe('DENY');
      expect(result.reason).toContain('per-transaction limit');
    });

    it('denies when payee not in allowed list', () => {
      const result = engine.evaluate({
        policy_id: policyId, agent_id: 'agent1',
        operation: 'purchase', amount_minor: 100, currency: 'USD', payee_id: 'unauthorized',
      });
      expect(result.decision).toBe('DENY');
      expect(result.reason).toContain('allowed payees');
    });

    it('denies when currency mismatches', () => {
      const result = engine.evaluate({
        policy_id: policyId, agent_id: 'agent1',
        operation: 'purchase', amount_minor: 100, currency: 'EUR', payee_id: 'merchant_a',
      });
      expect(result.decision).toBe('DENY');
    });

    it('denies when operation not allowed', () => {
      const result = engine.evaluate({
        policy_id: policyId, agent_id: 'agent1',
        operation: 'refund', amount_minor: 100, currency: 'USD', payee_id: 'merchant_a',
      });
      expect(result.decision).toBe('DENY');
    });

    it('denies when policy is revoked', () => {
      engine.revokePolicy(policyId, 'test');
      const result = engine.evaluate({
        policy_id: policyId, agent_id: 'agent1',
        operation: 'purchase', amount_minor: 100, currency: 'USD', payee_id: 'merchant_a',
      });
      expect(result.decision).toBe('DENY');
    });

    it('denies when budget is zero', () => {
      // Drain the budget
      db.prepare('UPDATE policies SET remaining_budget_minor = 0 WHERE id = ?').run(policyId);
      const result = engine.evaluate({
        policy_id: policyId, agent_id: 'agent1',
        operation: 'purchase', amount_minor: 1, currency: 'USD', payee_id: 'merchant_a',
      });
      expect(result.decision).toBe('DENY');
    });
  });

  describe('evaluate - ALLOW cases', () => {
    it('allows valid request within policy', () => {
      const policy = engine.createPolicy({
        owner_id: 'u', agent_id: 'a', name: 'n',
        max_amount_minor: 5000, budget_limit_minor: 10000,
      });
      const result = engine.evaluate({
        policy_id: policy.id, agent_id: 'a',
        operation: 'purchase', amount_minor: 1000, currency: 'USD', payee_id: 'anyone',
      });
      expect(result.decision).toBe('ALLOW');
    });
  });

  describe('evaluate - REQUIRE_APPROVAL', () => {
    it('returns REQUIRE_APPROVAL when policy requires it', () => {
      const policy = engine.createPolicy({
        owner_id: 'u', agent_id: 'a', name: 'n',
        max_amount_minor: 5000, budget_limit_minor: 10000,
        require_approval: true,
      });
      const result = engine.evaluate({
        policy_id: policy.id, agent_id: 'a',
        operation: 'purchase', amount_minor: 1000, currency: 'USD', payee_id: 'anyone',
      });
      expect(result.decision).toBe('REQUIRE_APPROVAL');
    });
  });

  describe('computePeriodKey', () => {
    it('daily: returns YYYY-MM-DD', () => {
      const d = new Date('2026-11-02T12:00:00Z');
      expect(computePeriodKey('daily', d)).toBe('2026-11-02');
    });

    it('monthly: returns YYYY-MM', () => {
      const d = new Date('2026-11-02T12:00:00Z');
      expect(computePeriodKey('monthly', d)).toBe('2026-11');
    });

    it('total: returns "total"', () => {
      expect(computePeriodKey('total')).toBe('total');
    });
  });
});
