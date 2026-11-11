/**
 * AI Adapter — generates structured payment proposals and semantic checks.
 *
 * AI output is ALWAYS validated against a strict Zod schema before use.
 * The AI cannot:
 *   - Raise the budget
 *   - Add trusted payees
 *   - Override DENY decisions
 *   - Fabricate payment success
 *   - Suppress audit events
 *
 * When AI is unavailable (no API key), falls back to deterministic proposal
 * generation and clearly labels responses as non-AI.
 */

import { z } from 'zod';
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';

export const PurchaseProposalSchema = z.object({
  item_name: z.string().min(1).max(200),
  description: z.string().min(1).max(500),
  estimated_amount_minor: z.number().int().positive(),
  currency: z.string().length(3),
  suggested_payee_id: z.string().optional(),
  suggested_payee_name: z.string().optional(),
  purchase_category: z.string().optional(),
  rationale: z.string().optional(),
  confidence: z.number().min(0).max(1),
  ai_generated: z.boolean(),
});

export type PurchaseProposal = z.infer<typeof PurchaseProposalSchema>;

export const SemanticCheckResultSchema = z.object({
  intent_matches: z.boolean(),
  confidence: z.number().min(0).max(1),
  mismatch_reason: z.string().optional(),
  flag_for_review: z.boolean(),
  ai_generated: z.boolean(),
});

export type SemanticCheckResult = z.infer<typeof SemanticCheckResultSchema>;

export type AIProvider = 'openai' | 'openrouter';

export interface AIConfig {
  provider: AIProvider;
  apiKey?: string;
  model: string;
  baseURL?: string;
}

export function resolveAIConfig(env: NodeJS.ProcessEnv = process.env): AIConfig {
  const configuredProvider = env.AI_PROVIDER?.trim().toLowerCase();
  if (configuredProvider && configuredProvider !== 'openai' && configuredProvider !== 'openrouter') {
    throw new Error(`Unsupported AI_PROVIDER "${configuredProvider}". Use "openai" or "openrouter".`);
  }

  const provider: AIProvider = configuredProvider === 'openai' || configuredProvider === 'openrouter'
    ? configuredProvider
    : env.OPENROUTER_API_KEY && !env.OPENAI_API_KEY
      ? 'openrouter'
      : 'openai';

  return {
    provider,
    apiKey: provider === 'openrouter' ? env.OPENROUTER_API_KEY : env.OPENAI_API_KEY,
    model: env.AI_MODEL?.trim() || (provider === 'openrouter' ? 'openrouter/free' : 'gpt-4o-mini'),
    baseURL: provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : undefined,
  };
}

export class AIAdapter {
  private hasApiKey: boolean;
  private apiKey?: string;
  private provider: AIProvider;
  private model: string;
  private baseURL?: string;

  constructor(options?: {
    provider?: AIProvider;
    apiKey?: string;
    model?: string;
    baseURL?: string;
  }) {
    const config = resolveAIConfig();
    this.provider = options?.provider ?? config.provider;
    this.apiKey = options?.apiKey ?? (options?.provider ? undefined : config.apiKey);
    this.hasApiKey = !!this.apiKey;
    this.model = options?.model?.trim() || (options?.provider ? undefined : config.model) || (this.provider === 'openrouter' ? 'openrouter/free' : 'gpt-4o-mini');
    this.baseURL = options?.baseURL ?? (this.provider === 'openrouter' ? 'https://openrouter.ai/api/v1' : config.baseURL);
  }

  private async createClient() {
    const { default: OpenAI } = await import('openai');
    return new OpenAI({
      apiKey: this.apiKey,
      ...(this.baseURL ? { baseURL: this.baseURL } : {}),
      ...(this.provider === 'openrouter' ? {
        defaultHeaders: {
          'HTTP-Referer': 'https://github.com/paultanay/payguard',
          'X-OpenRouter-Title': 'PayGuard',
        },
      } : {}),
    });
  }

  /**
   * Generate a structured purchase proposal from a natural-language request.
   * Validates output against PurchaseProposalSchema before returning.
   * Returns deterministic fallback if AI is unavailable.
   */
  async generateProposal(userRequest: string, context?: {
    policy_currency?: string;
    policy_max_amount_minor?: number;
  }): Promise<PurchaseProposal> {
    if (!this.hasApiKey) {
      return this.deterministicProposal(userRequest, context);
    }

    try {
      const systemPrompt = `You are a purchase proposal assistant. Given a user's purchase request, extract structured information.
Respond with ONLY a JSON object matching this schema (no markdown):
{
  "item_name": string (max 200 chars),
  "description": string (max 500 chars - include what, why, where if known),
  "estimated_amount_minor": number (integer minor units, e.g. USD cents: $12.99 = 1299),
  "currency": string (3-letter ISO code, default USD),
  "suggested_payee_id": string (domain/merchant identifier if determinable, else omit),
  "suggested_payee_name": string (merchant name if determinable, else omit),
  "purchase_category": string (electronics/office/software/food/travel/other),
  "rationale": string (brief explanation),
  "confidence": number (0.0 to 1.0),
  "ai_generated": true
}

Currency policy: ${context?.policy_currency ?? 'USD'}
Policy max amount: ${context?.policy_max_amount_minor ? context.policy_max_amount_minor + ' minor units' : 'not specified'}.
This limit is informational only. Extract the user's requested amount faithfully; never lower or clamp it to fit a policy. The deterministic policy engine will decide whether the amount is allowed.`;

      const client = await this.createClient();

      const response = await client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userRequest },
        ],
        max_tokens: 1500,
        temperature: 0.1,
        ...(this.provider === 'openrouter' && this.model.includes('nemotron')
          ? { reasoning: { max_tokens: 256 } }
          : {}),
      } as unknown as ChatCompletionCreateParamsNonStreaming);

      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error('Empty AI response');

      const parsed = JSON.parse(content);
      return PurchaseProposalSchema.parse(parsed);
    } catch (err) {
      console.warn('[AI] Proposal generation failed, using fallback:', err instanceof Error ? err.message : err);
      return this.deterministicProposal(userRequest, context);
    }
  }

  /**
   * Check whether a proposed transaction semantically matches the user's original request.
   *
   * IMPORTANT: This is an advisory check only. A mismatch flags for human review
   * but does NOT automatically authorize a transaction. The deterministic policy
   * engine is the final security gate.
   *
   * This check cannot prevent all prompt injection — it is one layer, not the boundary.
   */
  async semanticIntentCheck(
    originalRequest: string,
    proposedIntent: {
      description: string;
      amount_minor: number;
      currency: string;
      payee_id: string;
    },
  ): Promise<SemanticCheckResult> {
    if (!this.hasApiKey) {
      return {
        intent_matches: true,
        confidence: 0.5,
        mismatch_reason: undefined,
        flag_for_review: false,
        ai_generated: false,
      };
    }

    try {
      const systemPrompt = `You are a payment intent verifier. Check whether a proposed payment matches the user's original request.
Respond with ONLY a JSON object (no markdown):
{
  "intent_matches": boolean (does the proposal match what was requested?),
  "confidence": number (0.0-1.0),
  "mismatch_reason": string or null (specific reason if mismatched),
  "flag_for_review": boolean (true if you're uncertain or there's a partial mismatch),
  "ai_generated": true
}

Evaluate: same item category, reasonable amount, appropriate merchant.
Be conservative — flag mismatches rather than silently passing suspicious proposals.`;

      const client = await this.createClient();

      const userContent = `Original request: "${originalRequest}"
Proposed payment: ${proposedIntent.description} for ${proposedIntent.amount_minor} minor units of ${proposedIntent.currency} to payee ${proposedIntent.payee_id}`;

      const response = await client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        max_tokens: 300,
        temperature: 0,
        ...(this.provider === 'openrouter' && this.model.includes('nemotron')
          ? { reasoning: { max_tokens: 256 } }
          : {}),
      } as unknown as ChatCompletionCreateParamsNonStreaming);

      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error('Empty AI response');

      const parsed = JSON.parse(content);
      return SemanticCheckResultSchema.parse(parsed);
    } catch (err) {
      console.warn('[AI] Semantic check failed:', err instanceof Error ? err.message : err);
      return {
        intent_matches: true,
        confidence: 0,
        flag_for_review: true,
        mismatch_reason: 'AI check unavailable — manual review recommended',
        ai_generated: false,
      };
    }
  }

  private deterministicProposal(
    userRequest: string,
    context?: { policy_currency?: string; policy_max_amount_minor?: number }
  ): PurchaseProposal {
    // Simple heuristic extraction for demo when no API key
    const currency = context?.policy_currency ?? 'USD';
    const maxAmount = context?.policy_max_amount_minor ?? 10000; // $100 default

    // Extract amount from request if mentioned
    const amountMatch = userRequest.match(/\$(\d+(?:\.\d{1,2})?)/);
    let estimatedAmount = amountMatch ? Math.round(parseFloat(amountMatch[1]) * 100) : Math.min(2999, maxAmount);

    return {
      item_name: userRequest.slice(0, 100),
      description: `Purchase request: ${userRequest.slice(0, 400)}`,
      estimated_amount_minor: estimatedAmount,
      currency,
      suggested_payee_name: 'General Merchant',
      purchase_category: 'other',
      rationale: 'Deterministic fallback (no AI key configured)',
      confidence: 0.3,
      ai_generated: false,
    };
  }
}
