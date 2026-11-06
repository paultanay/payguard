import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PolicyEngine } from '../policy/engine.js';
import { IntentService } from '../intent/service.js';
import { ApprovalService } from '../approval/service.js';
import { AuditService } from '../audit/service.js';
import { AIAdapter } from '../ai/adapter.js';
import type { PaymentProvider } from '../provider/interface.js';
import type Database from 'better-sqlite3';

export function registerRoutes(
  app: FastifyInstance,
  db: Database.Database,
  provider: PaymentProvider,
): void {
  const policyEngine = new PolicyEngine(db);
  const intentService = new IntentService(db, provider);
  const approvalService = new ApprovalService(db);
  const auditService = new AuditService(db);
  const aiAdapter = new AIAdapter();

  // ─── Health ───────────────────────────────────────────────────────────────
  app.get('/health', async () => ({
    status: 'ok',
    provider_mode: provider.mode,
    timestamp: new Date().toISOString(),
  }));

  // ─── Policies ─────────────────────────────────────────────────────────────
  app.get('/api/policies', async () => {
    return { policies: policyEngine.listPolicies() };
  });

  app.post('/api/policies', async (req, reply) => {
    const body = z.object({
      owner_id: z.string().min(1),
      agent_id: z.string().min(1),
      name: z.string().min(1),
      description: z.string().optional(),
      allowed_operations: z.array(z.string()).optional(),
      allowed_payees: z.array(z.string()).optional(),
      max_amount_minor: z.number().int().positive(),
      currency: z.string().length(3).optional(),
      budget_period: z.enum(['daily', 'weekly', 'monthly', 'total']).optional(),
      budget_limit_minor: z.number().int().positive(),
      require_approval: z.boolean().optional(),
      expires_at: z.string().optional(),
    }).safeParse(req.body);

    if (!body.success) {
      return reply.code(400).send({ error: 'Validation failed', details: body.error.issues });
    }

    try {
      const policy = policyEngine.createPolicy(body.data as never);
      auditService.record('POLICY_CREATED', policy.id, 'policy', {
        name: policy.name, agent_id: policy.agent_id,
      }, body.data.owner_id);
      return reply.code(201).send({ policy });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Failed to create policy' });
    }
  });

  app.get('/api/policies/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const policy = policyEngine.getPolicyById(id);
    if (!policy) return reply.code(404).send({ error: 'Policy not found' });
    return { policy };
  });

  app.patch('/api/policies/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      max_amount_minor: z.number().int().positive().optional(),
      budget_limit_minor: z.number().int().positive().optional(),
      require_approval: z.boolean().optional(),
      allowed_payees: z.array(z.string()).optional(),
    }).safeParse(req.body);

    if (!body.success) {
      return reply.code(400).send({ error: 'Validation failed', details: body.error.issues });
    }

    const updated = policyEngine.updatePolicy(id, body.data);
    if (!updated) return reply.code(404).send({ error: 'Policy not found or not active' });
    auditService.record('POLICY_UPDATED', id, 'policy', body.data as Record<string, unknown>, 'user');
    return { policy: updated };
  });

  app.delete('/api/policies/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ reason: z.string().optional() }).safeParse(req.body);
    const revoked = policyEngine.revokePolicy(id, body.success ? body.data.reason ?? 'User requested' : 'User requested');
    if (!revoked) return reply.code(404).send({ error: 'Policy not found or already revoked' });
    auditService.record('POLICY_REVOKED', id, 'policy', { reason: 'User requested' }, 'user');
    return { success: true };
  });

  // ─── AI Proposals ─────────────────────────────────────────────────────────
  app.post('/api/ai/propose', async (req, reply) => {
    const body = z.object({
      user_request: z.string().min(1).max(1000),
      policy_id: z.string().optional(),
    }).safeParse(req.body);

    if (!body.success) {
      return reply.code(400).send({ error: 'Validation failed', details: body.error.issues });
    }

    const policy = body.data.policy_id ? policyEngine.getPolicyById(body.data.policy_id) : null;
    const proposal = await aiAdapter.generateProposal(body.data.user_request, {
      policy_currency: policy?.currency,
      policy_max_amount_minor: policy?.max_amount_minor,
    });

    auditService.record('AI_PROPOSAL_CREATED', `req_${Date.now()}`, 'ai_request', {
      user_request: body.data.user_request.slice(0, 200),
      ai_generated: proposal.ai_generated,
      estimated_amount_minor: proposal.estimated_amount_minor,
    }, 'ai_agent');

    return { proposal };
  });

  app.post('/api/ai/semantic-check', async (req, reply) => {
    const body = z.object({
      original_request: z.string().min(1),
      intent_id: z.string().min(1),
    }).safeParse(req.body);

    if (!body.success) {
      return reply.code(400).send({ error: 'Validation failed', details: body.error.issues });
    }

    const intent = intentService.getIntent(body.data.intent_id);
    if (!intent) return reply.code(404).send({ error: 'Intent not found' });

    const result = await aiAdapter.semanticIntentCheck(body.data.original_request, {
      description: intent.description,
      amount_minor: intent.amount_minor,
      currency: intent.currency,
      payee_id: intent.payee_id,
    });

    auditService.record('AI_SEMANTIC_CHECK', body.data.intent_id, 'intent', {
      intent_matches: result.intent_matches,
      flag_for_review: result.flag_for_review,
      confidence: result.confidence,
    }, 'ai_agent');

    return { result };
  });

  // ─── Intents ──────────────────────────────────────────────────────────────
  app.post('/api/intents', async (req, reply) => {
    const body = z.object({
      policy_id: z.string().min(1),
      agent_id: z.string().min(1),
      operation: z.string().optional(),
      amount_minor: z.number().int().positive(),
      currency: z.string().length(3),
      payee_id: z.string().min(1),
      payee_name: z.string().optional(),
      description: z.string().min(1),
      idempotency_key: z.string().optional(),
      ttl_seconds: z.number().int().positive().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }).safeParse(req.body);

    if (!body.success) {
      return reply.code(400).send({ error: 'Validation failed', details: body.error.issues });
    }

    try {
      const result = await intentService.createIntent(body.data as never);
      return reply.code(result.idempotent ? 200 : 201).send(result);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : 'Failed to create intent' });
    }
  });

  app.get('/api/intents', async (req) => {
    const { limit, offset } = (req.query as { limit?: string; offset?: string });
    return { intents: intentService.listIntents(Number(limit) || 50, Number(offset) || 0) };
  });

  app.get('/api/intents/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const intent = intentService.getIntent(id);
    if (!intent) return reply.code(404).send({ error: 'Intent not found' });
    return { intent };
  });

  // ─── Payments ─────────────────────────────────────────────────────────────
  app.post('/api/intents/:id/execute', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      return_url: z.string().optional(),
      cancel_url: z.string().optional(),
    }).safeParse(req.body);

    try {
      const result = await intentService.executePayment({
        intent_id: id,
        return_url: body.success ? body.data.return_url : undefined,
        cancel_url: body.success ? body.data.cancel_url : undefined,
      });
      const statusCode = result.success ? 200 : (result.state === 'PENDING_APPROVAL' ? 202 : 422);
      return reply.code(statusCode).send(result);
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : 'Execution failed' });
    }
  });

  app.post('/api/transactions/:id/capture', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const result = await intentService.capturePayment(id);
      return reply.code(result.success ? 200 : 422).send(result);
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : 'Capture failed' });
    }
  });

  // ─── Transactions ─────────────────────────────────────────────────────────
  app.get('/api/transactions', async (req) => {
    const { limit, offset } = (req.query as { limit?: string; offset?: string });
    return { transactions: intentService.listTransactions(Number(limit) || 50, Number(offset) || 0) };
  });

  app.get('/api/transactions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const txn = intentService.getTransaction(id);
    if (!txn) return reply.code(404).send({ error: 'Transaction not found' });
    return { transaction: txn };
  });

  // ─── Approvals ────────────────────────────────────────────────────────────
  app.get('/api/approvals/pending', async () => {
    return { approvals: approvalService.listPendingApprovals() };
  });

  app.post('/api/approvals/:id/approve', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ approved_by: z.string().default('user') }).safeParse(req.body);
    const approvedBy = body.success ? body.data.approved_by : 'user';

    const approval = approvalService.getApproval(id);
    if (!approval) return reply.code(404).send({ error: 'Approval not found' });

    const intent = intentService.getIntent(approval.intent_id);
    if (!intent) return reply.code(404).send({ error: 'Intent not found' });

    const result = approvalService.approve(id, approvedBy, {
      amount_minor: intent.amount_minor,
      currency: intent.currency,
      payee_id: intent.payee_id,
      description: intent.description,
    });

    if (!result.success) return reply.code(400).send({ error: result.reason });

    auditService.record('APPROVAL_GRANTED', approval.intent_id, 'intent', {
      approval_id: id, approved_by: approvedBy,
    }, approvedBy);

    // Update intent state
    db.prepare("UPDATE payment_intents SET state = 'PROPOSED', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), approval.intent_id);

    return { success: true };
  });

  app.post('/api/approvals/:id/reject', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ reason: z.string().default('Rejected by user') }).safeParse(req.body);
    const reason = body.success ? body.data.reason : 'Rejected by user';

    const approval = approvalService.getApproval(id);
    if (!approval) return reply.code(404).send({ error: 'Approval not found' });

    approvalService.reject(id, reason);
    auditService.record('APPROVAL_REJECTED', approval.intent_id, 'intent', {
      approval_id: id, reason,
    }, 'user');

    return { success: true };
  });

  // ─── Audit ────────────────────────────────────────────────────────────────
  app.get('/api/audit', async (req) => {
    const { entity_id, limit, offset } = (req.query as Record<string, string>);
    const events = auditService.getEvents({
      entity_id,
      limit: Number(limit) || 100,
      offset: Number(offset) || 0,
    });
    return { events };
  });

  // ─── PayTrace export / import ─────────────────────────────────────────────
  app.get('/api/audit/export', async (req) => {
    const { intent_id } = req.query as { intent_id?: string };
    const { PayTraceExporter } = await import('../audit/paytrace.js');
    const exporter = new PayTraceExporter(db);
    const bundle = exporter.export(intent_id, provider.mode);
    return bundle;
  });

  app.post('/api/audit/import-verify', async (req, reply) => {
    const { PayTraceExporter } = await import('../audit/paytrace.js');
    const result = PayTraceExporter.verify(req.body);
    return result;
  });

  app.post('/api/audit/verify', async () => {
    const result = auditService.verify();
    auditService.record('AUDIT_VERIFIED', 'system', 'audit', {
      valid: result.valid, total_events: result.total_events, errors: result.errors,
    }, 'user');
    return { verification: result };
  });

  // ─── Dashboard Stats ──────────────────────────────────────────────────────
  app.get('/api/stats', async () => {
    const policies = policyEngine.listPolicies();
    const activePolicy = policies.find((p) => p.status === 'active') ?? null;

    const txnStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN state = 'SUCCEEDED' THEN amount_minor ELSE 0 END) as committed_spend,
        SUM(CASE WHEN state IN ('RESERVED','PAYMENT_PENDING','AUTHORIZED','CAPTURE_PENDING') THEN amount_minor ELSE 0 END) as outstanding_reservations,
        SUM(CASE WHEN state = 'SUCCEEDED' THEN 1 ELSE 0 END) as succeeded,
        SUM(CASE WHEN state = 'FAILED' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN state = 'PENDING_APPROVAL' THEN 1 ELSE 0 END) as pending_approval
      FROM transactions
    `).get() as Record<string, number>;

    const pendingApprovals = approvalService.listPendingApprovals().length;
    const recentEvents = auditService.getEvents({ limit: 10 });

    return {
      provider_mode: provider.mode,
      active_policy: activePolicy,
      committed_spend_minor: txnStats.committed_spend ?? 0,
      outstanding_reservations_minor: txnStats.outstanding_reservations ?? 0,
      remaining_budget_minor: activePolicy?.remaining_budget_minor ?? 0,
      transaction_stats: {
        total: txnStats.total ?? 0,
        succeeded: txnStats.succeeded ?? 0,
        failed: txnStats.failed ?? 0,
        pending_approval: txnStats.pending_approval ?? 0,
      },
      pending_approvals: pendingApprovals,
      recent_audit_events: recentEvents,
    };
  });

  // ─── Security Lab (Attack Simulator) ──────────────────────────────────────
  app.post('/api/lab/run-scenario', async (req, reply) => {
    const body = z.object({
      scenario: z.enum([
        'valid_payment',
        'exceed_per_transaction_limit',
        'exhaust_budget',
        'unauthorized_payee',
        'expired_intent',
        'replay_attack',
        'tampered_payload',
        'duplicate_concurrent',
        'budget_race',
        'malicious_ai_output',
        'invalid_approval',
        'provider_timeout',
        'tampered_audit',
        'malformed_ai_output',
      ]),
      policy_id: z.string().optional(),
    }).safeParse(req.body);

    if (!body.success) {
      return reply.code(400).send({ error: 'Validation failed' });
    }

    const { runLabScenario } = await import('./lab.js');
    const result = await runLabScenario(body.data.scenario, db, body.data.policy_id);
    return result;
  });
}
