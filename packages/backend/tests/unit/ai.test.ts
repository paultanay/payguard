import { describe, expect, it } from 'vitest';
import { AIAdapter } from '../../src/ai/adapter.js';

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
});
