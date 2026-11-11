import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { registerRoutes } from '../../src/api/routes.js';
import { createTestDb } from '../../src/db/connection.js';
import { IntentService } from '../../src/intent/service.js';
import { PaymentSimulator } from '../../src/provider/simulator.js';

describe('Approval flow', () => {
  it('marks a rejected intent as failed so it cannot remain pending forever', async () => {
    const db = createTestDb();
    const provider = new PaymentSimulator();
    const app = Fastify();
    registerRoutes(app, db, provider);

    try {
      const policyResponse = await app.inject({
        method: 'POST',
        url: '/api/policies',
        payload: {
          owner_id: 'user', agent_id: 'agent', name: 'Approval policy',
          max_amount_minor: 5000, budget_limit_minor: 10000, require_approval: true,
        },
      });
      const policyId = policyResponse.json().policy.id as string;
      const intentResponse = await app.inject({
        method: 'POST',
        url: '/api/intents',
        payload: {
          policy_id: policyId, agent_id: 'agent', amount_minor: 1000,
          currency: 'USD', payee_id: 'merchant', description: 'Test purchase',
        },
      });
      const created = intentResponse.json();

      const rejection = await app.inject({
        method: 'POST',
        url: `/api/approvals/${created.approval_id}/reject`,
        payload: { reason: 'Not approved' },
      });

      expect(rejection.statusCode).toBe(200);
      expect(new IntentService(db, provider).getIntent(created.intent.id)?.state).toBe('FAILED');
    } finally {
      await app.close();
      db.close();
    }
  });
});
