import type { PurchaseProposal, SemanticCheckResult } from '../../backend/src/ai/adapter.js';
import type { Approval } from '../../backend/src/approval/service.js';
import type { AuditEvent, VerificationResult } from '../../backend/src/audit/service.js';
import type { LabResult } from '../../backend/src/api/lab.js';
import type { IntentRow, TransactionRow, ExecutePaymentResult } from '../../backend/src/intent/service.js';
import type { SignedIntent } from '../../backend/src/intent/model.js';
import type { Policy, Operation, BudgetPeriod } from '../../backend/src/policy/model.js';

interface CreatePolicyBody {
  owner_id: string;
  agent_id: string;
  name: string;
  description?: string;
  allowed_operations?: Operation[];
  allowed_payees?: string[];
  max_amount_minor: number;
  currency?: string;
  budget_period?: BudgetPeriod;
  budget_limit_minor: number;
  require_approval?: boolean;
  expires_at?: string;
}

interface Stats {
  provider_mode: string;
  active_policy: Policy | null;
  committed_spend_minor: number;
  outstanding_reservations_minor: number;
  remaining_budget_minor: number;
  transaction_stats: { total: number; succeeded: number; failed: number; pending_approval: number };
  pending_approvals: number;
  recent_audit_events: AuditEvent[];
}

interface IntentCreationResult {
  intent: SignedIntent;
  decision: 'ALLOW' | 'REQUIRE_APPROVAL' | 'DENY' | 'IDEMPOTENT';
  reason: string;
  approval_id?: string;
  idempotent: boolean;
}

interface CaptureResult {
  success: boolean;
  state: string;
  transaction_id?: string;
  capture_id?: string;
  error?: string;
  provider_mode: string;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: unknown = await response.json();
  if (!response.ok) {
    const message = typeof data === 'object' && data !== null && 'error' in data && typeof data.error === 'string'
      ? data.error
      : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data as T;
}

const BASE = '/api';

export const api = {
  getStats: () => req<Stats>('GET', '/stats'),
  listPolicies: () => req<{ policies: Policy[] }>('GET', '/policies'),
  createPolicy: (body: CreatePolicyBody) => req<{ policy: Policy }>('POST', '/policies', body),
  getPolicy: (id: string) => req<{ policy: Policy }>('GET', `/policies/${id}`),
  updatePolicy: (id: string, body: Partial<Pick<Policy, 'max_amount_minor' | 'budget_limit_minor' | 'require_approval' | 'allowed_payees'>>) => req<{ policy: Policy }>('PATCH', `/policies/${id}`, body),
  revokePolicy: (id: string) => req<{ success: boolean }>('DELETE', `/policies/${id}`, { reason: 'User revoked' }),

  generateProposal: (user_request: string, policy_id?: string) =>
    req<{ proposal: PurchaseProposal }>('POST', '/ai/propose', { user_request, policy_id }),
  semanticCheck: (original_request: string, intent_id: string) =>
    req<{ result: SemanticCheckResult }>('POST', '/ai/semantic-check', { original_request, intent_id }),

  listIntents: () => req<{ intents: IntentRow[] }>('GET', '/intents'),
  createIntent: (body: {
    policy_id: string; agent_id: string; operation?: string; amount_minor: number;
    currency: string; payee_id: string; payee_name?: string; description: string;
    idempotency_key?: string; ttl_seconds?: number; metadata?: Record<string, unknown>;
  }) => req<IntentCreationResult>('POST', '/intents', body),
  getIntent: (id: string) => req<{ intent: IntentRow }>('GET', `/intents/${id}`),
  executeIntent: (id: string) => {
    const frontendUrl = window.location.origin;
    const returnUrl = new URL(`/transactions?payment=returned&intent_id=${encodeURIComponent(id)}`, frontendUrl).toString();
    const cancelUrl = new URL(`/transactions?payment=cancelled&intent_id=${encodeURIComponent(id)}`, frontendUrl).toString();
    return req<ExecutePaymentResult>('POST', `/intents/${id}/execute`, { return_url: returnUrl, cancel_url: cancelUrl });
  },

  listTransactions: () => req<{ transactions: TransactionRow[] }>('GET', '/transactions'),
  getTransaction: (id: string) => req<{ transaction: TransactionRow }>('GET', `/transactions/${id}`),
  captureTransaction: (id: string) => req<CaptureResult>('POST', `/transactions/${id}/capture`, {}),

  listPendingApprovals: () => req<{ approvals: Approval[] }>('GET', '/approvals/pending'),
  approveApproval: (id: string) => req<{ success: boolean }>('POST', `/approvals/${id}/approve`, { approved_by: 'dashboard_user' }),
  rejectApproval: (id: string) => req<{ success: boolean }>('POST', `/approvals/${id}/reject`, { reason: 'Rejected via dashboard' }),

  getAuditEvents: (entity_id?: string) =>
    req<{ events: AuditEvent[] }>('GET', `/audit${entity_id ? `?entity_id=${encodeURIComponent(entity_id)}` : ''}`),
  verifyAudit: () => req<{ verification: VerificationResult }>('POST', '/audit/verify', {}),

  runLabScenario: (scenario: string, policy_id?: string) =>
    req<LabResult>('POST', '/lab/run-scenario', { scenario, policy_id }),
};

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An unexpected error occurred';
}
