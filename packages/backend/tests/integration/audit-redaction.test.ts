import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { registerRoutes } from '../../src/api/routes.js';
import { createTestDb } from '../../src/db/connection.js';
import { AuditService } from '../../src/audit/service.js';
import { PaymentSimulator } from '../../src/provider/simulator.js';

describe('AI request audit data', () => {
  const previousOpenAIKey = process.env.OPENAI_API_KEY;
  const previousOpenRouterKey = process.env.OPENROUTER_API_KEY;

  afterEach(() => {
    if (previousOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAIKey;
    if (previousOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousOpenRouterKey;
  });

  it('does not store the raw prompt in the audit trail', async () => {
    process.env.OPENAI_API_KEY = '';
    process.env.OPENROUTER_API_KEY = '';
    const db = createTestDb();
    const app = Fastify();
    registerRoutes(app, db, new PaymentSimulator());

    const privateText = 'Buy a cable; customer token is confidential-value-123';
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/ai/propose',
        payload: { user_request: privateText },
      });

      expect(response.statusCode).toBe(200);
      const [event] = new AuditService(db).getEvents({ entity_type: 'ai_request' });
      expect(JSON.stringify(event.metadata)).not.toContain(privateText);
      expect(event.metadata.user_request_length).toBe(privateText.length);
    } finally {
      await app.close();
      db.close();
    }
  });
});
