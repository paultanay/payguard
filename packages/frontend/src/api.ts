const BASE = '/api';

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data as T;
}

export const api = {
  // Stats
  getStats: () => req<any>('GET', '/stats'),

  // Policies
  listPolicies: () => req<any>('GET', '/policies'),
  createPolicy: (body: any) => req<any>('POST', '/policies', body),
  getPolicy: (id: string) => req<any>('GET', `/policies/${id}`),
  updatePolicy: (id: string, body: any) => req<any>('PATCH', `/policies/${id}`, body),
  revokePolicy: (id: string) => req<any>('DELETE', `/policies/${id}`, { reason: 'User revoked' }),

  // AI
  generateProposal: (user_request: string, policy_id?: string) =>
    req<any>('POST', '/ai/propose', { user_request, policy_id }),
  semanticCheck: (original_request: string, intent_id: string) =>
    req<any>('POST', '/ai/semantic-check', { original_request, intent_id }),

  // Intents
  listIntents: () => req<any>('GET', '/intents'),
  createIntent: (body: any) => req<any>('POST', '/intents', body),
  getIntent: (id: string) => req<any>('GET', `/intents/${id}`),
  executeIntent: (id: string) => {
    const frontendUrl = window.location.origin;
    const returnUrl = new URL(`/transactions?payment=returned&intent_id=${encodeURIComponent(id)}`, frontendUrl).toString();
    const cancelUrl = new URL(`/transactions?payment=cancelled&intent_id=${encodeURIComponent(id)}`, frontendUrl).toString();
    return req<any>('POST', `/intents/${id}/execute`, { return_url: returnUrl, cancel_url: cancelUrl });
  },

  // Transactions
  listTransactions: () => req<any>('GET', '/transactions'),
  getTransaction: (id: string) => req<any>('GET', `/transactions/${id}`),
  captureTransaction: (id: string) => req<any>('POST', `/transactions/${id}/capture`, {}),

  // Approvals
  listPendingApprovals: () => req<any>('GET', '/approvals/pending'),
  approveApproval: (id: string) => req<any>('POST', `/approvals/${id}/approve`, { approved_by: 'dashboard_user' }),
  rejectApproval: (id: string) => req<any>('POST', `/approvals/${id}/reject`, { reason: 'Rejected via dashboard' }),

  // Audit
  getAuditEvents: (entity_id?: string) =>
    req<any>('GET', `/audit${entity_id ? `?entity_id=${entity_id}` : ''}`),
  verifyAudit: () => req<any>('POST', '/audit/verify', {}),

  // Lab
  runLabScenario: (scenario: string, policy_id?: string) =>
    req<any>('POST', '/lab/run-scenario', { scenario, policy_id }),
};
