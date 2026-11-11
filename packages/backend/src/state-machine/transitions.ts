/**
 * Payment State Machine
 *
 * All state transitions are validated here. Only the backend may advance state.
 * The frontend cannot directly set SUCCEEDED.
 */

import type { PaymentIntentState } from '../intent/model.js';

type TransitionMap = Partial<Record<PaymentIntentState, PaymentIntentState[]>>;

const ALLOWED_TRANSITIONS: TransitionMap = {
  PROPOSED: ['PENDING_APPROVAL', 'RESERVED', 'EXPIRED', 'FAILED'],
  PENDING_APPROVAL: ['PROPOSED', 'EXPIRED', 'FAILED'],
  RESERVED: ['PAYMENT_PENDING', 'RELEASED', 'EXPIRED', 'FAILED', 'RECONCILIATION_REQUIRED'],
  PAYMENT_PENDING: ['AUTHORIZED', 'CAPTURE_PENDING', 'SUCCEEDED', 'FAILED', 'RECONCILIATION_REQUIRED'],
  AUTHORIZED: ['CAPTURE_PENDING', 'RELEASED', 'FAILED'],
  CAPTURE_PENDING: ['SUCCEEDED', 'FAILED', 'RECONCILIATION_REQUIRED'],
  SUCCEEDED: [],
  FAILED: ['RECONCILIATION_REQUIRED'],
  RELEASED: [],
  EXPIRED: [],
  RECONCILIATION_REQUIRED: ['SUCCEEDED', 'FAILED', 'RELEASED'],
} as unknown as TransitionMap;

export type TransitionActor = 'system' | 'user' | 'provider' | 'ai_agent' | 'mcp_client';

export interface TransitionRequest {
  from: PaymentIntentState;
  to: PaymentIntentState;
  actor: TransitionActor;
  reason: string;
}

export interface TransitionResult {
  allowed: boolean;
  reason: string;
}

export function validateTransition(req: TransitionRequest): TransitionResult {
  const allowed = ALLOWED_TRANSITIONS[req.from] ?? [];
  if (!(allowed as string[]).includes(req.to)) {
    return {
      allowed: false,
      reason: `Transition ${req.from} → ${req.to} is not permitted`,
    };
  }

  // Actor constraints
  if (req.to === 'SUCCEEDED' && req.actor === 'ai_agent') {
    return {
      allowed: false,
      reason: 'AI agent cannot directly mark a payment as SUCCEEDED',
    };
  }

  if (req.to === 'AUTHORIZED' && req.actor === 'ai_agent') {
    return {
      allowed: false,
      reason: 'AI agent cannot directly authorize a payment',
    };
  }

  return { allowed: true, reason: 'Transition permitted' };
}

export function getAllowedTransitions(from: PaymentIntentState): PaymentIntentState[] {
  return (ALLOWED_TRANSITIONS[from] ?? []) as PaymentIntentState[];
}
