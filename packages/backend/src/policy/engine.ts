/**
 * Policy Engine — deterministic, no LLM involvement.
 *
 * Returns one of: ALLOW | REQUIRE_APPROVAL | DENY
 * A DENY from this engine cannot be overridden by an LLM.
 */

import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { computePeriodKey, CreatePolicyInputSchema, type CreatePolicyInput, type Policy } from './model.js';

export type PolicyDecision = 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY';

export interface PolicyEvaluationRequest {
  policy_id: string;
  agent_id: string;
  operation: string;
  amount_minor: number;
  currency: string;
  payee_id: string;
}

export interface PolicyEvaluationResult {
  decision: PolicyDecision;
  policy_id: string;
  policy_version: number;
  reason: string;
  /** Remaining budget BEFORE this transaction (informational only — reservation is atomic) */
  remaining_budget_minor: number;
  period_key: string;
}

export class PolicyEngine {
  constructor(private db: Database.Database) {}

  createPolicy(input: CreatePolicyInput): Policy {
    const validated = CreatePolicyInputSchema.parse(input);
    const id = `pol_${nanoid(16)}`;
    const now = new Date().toISOString();
    const periodKey = computePeriodKey(validated.budget_period);

    const row = {
      id,
      version: 1,
      owner_id: validated.owner_id,
      agent_id: validated.agent_id,
      name: validated.name,
      description: validated.description ?? null,
      allowed_operations: JSON.stringify(validated.allowed_operations),
      allowed_payees: JSON.stringify(validated.allowed_payees),
      max_amount_minor: validated.max_amount_minor,
      currency: validated.currency,
      budget_period: validated.budget_period,
      budget_limit_minor: validated.budget_limit_minor,
      remaining_budget_minor: validated.budget_limit_minor,
      budget_period_key: periodKey,
      require_approval: validated.require_approval ? 1 : 0,
      status: 'active',
      created_at: now,
      updated_at: now,
      expires_at: validated.expires_at ?? null,
      metadata: '{}',
    };

    this.db.prepare(`
      INSERT INTO policies (
        id, version, owner_id, agent_id, name, description,
        allowed_operations, allowed_payees, max_amount_minor, currency,
        budget_period, budget_limit_minor, remaining_budget_minor, budget_period_key,
        require_approval, status, created_at, updated_at, expires_at, metadata
      ) VALUES (
        @id, @version, @owner_id, @agent_id, @name, @description,
        @allowed_operations, @allowed_payees, @max_amount_minor, @currency,
        @budget_period, @budget_limit_minor, @remaining_budget_minor, @budget_period_key,
        @require_approval, @status, @created_at, @updated_at, @expires_at, @metadata
      )
    `).run(row);

    return this.getPolicyById(id)!;
  }

  getPolicyById(id: string): Policy | null {
    const row = this.db.prepare('SELECT * FROM policies WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToPolicy(row);
  }

  getPolicyForAgent(agentId: string): Policy | null {
    const row = this.db.prepare(
      "SELECT * FROM policies WHERE agent_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1"
    ).get(agentId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToPolicy(row);
  }

  listPolicies(): Policy[] {
    const rows = this.db.prepare('SELECT * FROM policies ORDER BY created_at DESC').all() as Record<string, unknown>[];
    return rows.map((r) => this.rowToPolicy(r));
  }

  /**
   * Evaluate a payment request against the policy.
   * This is a READ-ONLY operation — it does NOT reserve budget.
   * Budget reservation is handled atomically by BudgetService.
   */
  evaluate(req: PolicyEvaluationRequest): PolicyEvaluationResult {
    const policy = this.getPolicyById(req.policy_id);

    if (!policy) {
      return deny('Policy not found', req.policy_id, 0, 0, '');
    }

    if (policy.status !== 'active') {
      return deny(`Policy is ${policy.status}`, req.policy_id, policy.version, 0, policy.budget_period_key);
    }

    if (policy.expires_at && new Date(policy.expires_at) <= new Date()) {
      return deny('Policy has expired', req.policy_id, policy.version, policy.remaining_budget_minor, policy.budget_period_key);
    }

    if (policy.agent_id !== req.agent_id) {
      return deny('Agent ID does not match policy', req.policy_id, policy.version, policy.remaining_budget_minor, policy.budget_period_key);
    }

    if (!policy.allowed_operations.includes(req.operation as never)) {
      return deny(`Operation '${req.operation}' not allowed by policy`, req.policy_id, policy.version, policy.remaining_budget_minor, policy.budget_period_key);
    }

    if (policy.currency !== req.currency) {
      return deny(`Currency mismatch: policy=${policy.currency}, request=${req.currency}`, req.policy_id, policy.version, policy.remaining_budget_minor, policy.budget_period_key);
    }

    if (req.amount_minor <= 0) {
      return deny('Amount must be positive', req.policy_id, policy.version, policy.remaining_budget_minor, policy.budget_period_key);
    }

    if (req.amount_minor > policy.max_amount_minor) {
      return deny(
        `Amount ${req.amount_minor} exceeds per-transaction limit ${policy.max_amount_minor}`,
        req.policy_id, policy.version, policy.remaining_budget_minor, policy.budget_period_key
      );
    }

    // Refresh period if needed (budget resets at period boundary)
    const currentPeriodKey = computePeriodKey(policy.budget_period);
    const effectiveRemaining = currentPeriodKey !== policy.budget_period_key
      ? policy.budget_limit_minor  // period rolled over, budget resets
      : policy.remaining_budget_minor;

    if (req.amount_minor > effectiveRemaining) {
      return deny(
        `Amount ${req.amount_minor} exceeds remaining budget ${effectiveRemaining} for period ${currentPeriodKey}`,
        req.policy_id, policy.version, policy.remaining_budget_minor, currentPeriodKey
      );
    }

    if (policy.allowed_payees.length > 0 && !policy.allowed_payees.includes(req.payee_id)) {
      return deny(
        `Payee '${req.payee_id}' is not in the allowed payees list`,
        req.policy_id, policy.version, policy.remaining_budget_minor, currentPeriodKey
      );
    }

    if (policy.require_approval) {
      return {
        decision: 'REQUIRE_APPROVAL',
        policy_id: req.policy_id,
        policy_version: policy.version,
        reason: 'Policy requires explicit human approval for this transaction',
        remaining_budget_minor: effectiveRemaining,
        period_key: currentPeriodKey,
      };
    }

    return {
      decision: 'ALLOW',
      policy_id: req.policy_id,
      policy_version: policy.version,
      reason: 'All policy checks passed',
      remaining_budget_minor: effectiveRemaining,
      period_key: currentPeriodKey,
    };
  }

  revokePolicy(id: string, reason: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      "UPDATE policies SET status = 'revoked', updated_at = ? WHERE id = ? AND status = 'active'"
    ).run(now, id);
    if (result.changes > 0) {
      this.db.prepare(
        "INSERT INTO revocation_records (id, entity_id, entity_type, revoked_at, reason) VALUES (?, ?, 'policy', ?, ?)"
      ).run(nanoid(), id, now, reason);
      return true;
    }
    return false;
  }

  updatePolicy(id: string, updates: Partial<CreatePolicyInput>): Policy | null {
    const policy = this.getPolicyById(id);
    if (!policy || policy.status !== 'active') return null;

    const now = new Date().toISOString();
    const sets: string[] = ['updated_at = @updated_at', 'version = version + 1'];
    const params: Record<string, unknown> = { id, updated_at: now };

    if (updates.max_amount_minor !== undefined) {
      sets.push('max_amount_minor = @max_amount_minor');
      params.max_amount_minor = updates.max_amount_minor;
    }
    if (updates.budget_limit_minor !== undefined) {
      sets.push('budget_limit_minor = @budget_limit_minor');
      sets.push('remaining_budget_minor = @budget_limit_minor');
      params.budget_limit_minor = updates.budget_limit_minor;
    }
    if (updates.require_approval !== undefined) {
      sets.push('require_approval = @require_approval');
      params.require_approval = updates.require_approval ? 1 : 0;
    }
    if (updates.allowed_payees !== undefined) {
      sets.push('allowed_payees = @allowed_payees');
      params.allowed_payees = JSON.stringify(updates.allowed_payees);
    }

    this.db.prepare(`UPDATE policies SET ${sets.join(', ')} WHERE id = @id`).run(params);
    return this.getPolicyById(id);
  }

  private rowToPolicy(row: Record<string, unknown>): Policy {
    return {
      id: row.id as string,
      version: row.version as number,
      owner_id: row.owner_id as string,
      agent_id: row.agent_id as string,
      name: row.name as string,
      description: row.description as string | undefined,
      allowed_operations: JSON.parse(row.allowed_operations as string),
      allowed_payees: JSON.parse(row.allowed_payees as string),
      max_amount_minor: row.max_amount_minor as number,
      currency: row.currency as string,
      budget_period: row.budget_period as never,
      budget_limit_minor: row.budget_limit_minor as number,
      remaining_budget_minor: row.remaining_budget_minor as number,
      budget_period_key: row.budget_period_key as string,
      require_approval: (row.require_approval as number) === 1,
      status: row.status as never,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
      expires_at: (row.expires_at as string | null) ?? undefined,
      metadata: JSON.parse((row.metadata as string) ?? '{}'),
    };
  }
}

function deny(
  reason: string,
  policy_id: string,
  policy_version: number,
  remaining_budget_minor: number,
  period_key: string,
): PolicyEvaluationResult {
  return { decision: 'DENY', policy_id, policy_version, reason, remaining_budget_minor, period_key };
}
