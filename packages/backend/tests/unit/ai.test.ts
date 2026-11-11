import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { AIAdapter, resolveAIConfig } from '../../src/ai/adapter.js';

describe('AI adapter fallback', () => {
  it('preserves an explicitly requested amount above policy limits for deterministic denial', async () => {
    const adapter = new AIAdapter({ apiKey: '' });

    const proposal = await adapter.generateProposal('Buy a 4K monitor for $800', {
      policy_currency: 'USD',
      policy_max_amount_minor: 5000,
    });

    expect(proposal.estimated_amount_minor).toBe(80000);
    expect(proposal.ai_generated).toBe(false);
  });

  it('selects OpenRouter and its free model when only an OpenRouter key is configured', () => {
    expect(resolveAIConfig({ OPENROUTER_API_KEY: 'router-key', AI_MODEL: '' })).toMatchObject({
      provider: 'openrouter',
      apiKey: 'router-key',
      model: 'openrouter/free',
      baseURL: 'https://openrouter.ai/api/v1',
    });
  });

  it('keeps direct OpenAI as the default when both providers have keys', () => {
    expect(resolveAIConfig({
      OPENAI_API_KEY: 'openai-key',
      OPENROUTER_API_KEY: 'router-key',
      AI_MODEL: '',
    })).toMatchObject({
      provider: 'openai',
      apiKey: 'openai-key',
      model: 'gpt-4o-mini',
      baseURL: undefined,
    });
  });

  it('sends OpenRouter-compatible chat completions and parses the proposal', async () => {
    let requestBody: Record<string, unknown> | undefined;
    let authorization: string | undefined;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        requestBody = JSON.parse(body) as Record<string, unknown>;
        authorization = req.headers.authorization;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'test-completion',
          object: 'chat.completion',
          created: 1,
          model: 'openrouter/free',
          choices: [{
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: JSON.stringify({
                item_name: 'Keyboard',
                description: 'Purchase request: Buy a keyboard for $30',
                estimated_amount_minor: 3000,
                currency: 'USD',
                confidence: 0.9,
                ai_generated: true,
              }),
            },
          }],
        }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');

    try {
      const adapter = new AIAdapter({
        provider: 'openrouter',
        apiKey: 'test-router-key',
        model: 'openrouter/free',
        baseURL: `http://127.0.0.1:${address.port}/api/v1`,
      });
      const proposal = await adapter.generateProposal('Buy a keyboard for $30');

      expect(proposal.item_name).toBe('Keyboard');
      expect(proposal.ai_generated).toBe(true);
      expect(authorization).toBe('Bearer test-router-key');
      expect(requestBody?.model).toBe('openrouter/free');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
