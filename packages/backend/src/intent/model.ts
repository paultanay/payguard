import { z } from 'zod';
import { canonicalJson, sha256 } from '../crypto/hash.js';
import { sign, getKeyPair } from '../crypto/keys.js';
import { nanoid } from 'nanoid';

export const PaymentIntentStateSchema = z.enum([
  'PROPOSED',
  'PENDING_APPROVAL',
  'RESERVED',
  'PAYMENT_PENDING',
  'AUTHORIZED',
  'CAPTURE_PENDING',
  'SUCCEEDED',
  'FAILED',
  'RELEASED',
  'EXPIRED',
  'RECONCILIATION_REQUIRED',
]);
export type PaymentIntentState = z.infer<typeof PaymentIntentStateSchema>;

/** All security-relevant fields that get signed. */
export interface IntentCanonicalFields {
  intent_id: string;
  policy_id: string;
  policy_version: number;
  agent_id: string;
  operation: string;
  /** Integer minor units - never floating point */
  amount_minor: number;
  currency: string;
  payee_id: string;
  description: string;
  nonce: string;
  idempotency_key: string;
  created_at: string;
  expires_at: string;
}

export const CreateIntentInputSchema = z.object({
  policy_id: z.string().min(1),
  agent_id: z.string().min(1),
  operation: z.string().default('purchase'),
  /** In minor units - e.g., USD cents */
  amount_minor: z.number().int().positive(),
  currency: z.string().length(3),
  payee_id: z.string().min(1),
  payee_name: z.string().optional(),
  description: z.string().min(1),
  idempotency_key: z.string().optional(),
  /** TTL in seconds, default 10 minutes */
  ttl_seconds: z.number().int().positive().default(600),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
// `z.infer` describes parsed output, where defaulted fields are required.
// Callers pass the schema input, so defaulted fields must remain optional here.
export type CreateIntentInput = z.input<typeof CreateIntentInputSchema>;

export interface SignedIntent {
  id: string;
  policy_id: string;
  policy_version: number;
  agent_id: string;
  nonce: string;
  idempotency_key: string;
  canonical_hash: string;
  signature: string;
  public_key_hex: string;
  amount_minor: number;
  currency: string;
  payee_id: string;
  payee_name?: string;
  description: string;
  operation: string;
  state: PaymentIntentState;
  created_at: string;
  expires_at: string;
  updated_at: string;
  metadata?: Record<string, unknown>;
}

export async function createSignedIntent(
  input: CreateIntentInput,
  policyVersion: number,
): Promise<SignedIntent> {
  const validated = CreateIntentInputSchema.parse(input);
  const id = `int_${nanoid(16)}`;
  const nonce = nanoid(32);
  const idempotencyKey = validated.idempotency_key ?? `idem_${nanoid(24)}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + validated.ttl_seconds * 1000);

  const canonical: IntentCanonicalFields = {
    intent_id: id,
    policy_id: validated.policy_id,
    policy_version: policyVersion,
    agent_id: validated.agent_id,
    operation: validated.operation,
    amount_minor: validated.amount_minor,
    currency: validated.currency,
    payee_id: validated.payee_id,
    description: validated.description,
    nonce,
    idempotency_key: idempotencyKey,
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
  };

  const canonicalStr = canonicalJson(canonical as unknown as Record<string, unknown>);
  const canonicalHash = sha256(canonicalStr);
  const messageBytes = new TextEncoder().encode(canonicalStr);
  const signature = await sign(messageBytes);
  const { publicKeyHex } = await getKeyPair();

  return {
    id,
    policy_id: validated.policy_id,
    policy_version: policyVersion,
    agent_id: validated.agent_id,
    nonce,
    idempotency_key: idempotencyKey,
    canonical_hash: canonicalHash,
    signature,
    public_key_hex: publicKeyHex,
    amount_minor: validated.amount_minor,
    currency: validated.currency,
    payee_id: validated.payee_id,
    payee_name: validated.payee_name,
    description: validated.description,
    operation: validated.operation,
    state: 'PROPOSED',
    created_at: now.toISOString(),
    expires_at: expiresAt.toISOString(),
    updated_at: now.toISOString(),
    metadata: validated.metadata,
  };
}

export async function verifyIntentSignature(
  intent: SignedIntent,
  publicKeyHex: string,
): Promise<{ valid: boolean; reason: string }> {
  const { verify } = await import('../crypto/keys.js');

  const canonical: IntentCanonicalFields = {
    intent_id: intent.id,
    policy_id: intent.policy_id,
    policy_version: intent.policy_version,
    agent_id: intent.agent_id,
    operation: intent.operation,
    amount_minor: intent.amount_minor,
    currency: intent.currency,
    payee_id: intent.payee_id,
    description: intent.description,
    nonce: intent.nonce,
    idempotency_key: intent.idempotency_key,
    created_at: intent.created_at,
    expires_at: intent.expires_at,
  };

  const canonicalStr = canonicalJson(canonical as unknown as Record<string, unknown>);
  const expectedHash = sha256(canonicalStr);

  if (expectedHash !== intent.canonical_hash) {
    return { valid: false, reason: 'Canonical hash mismatch - fields have been tampered with' };
  }

  const messageBytes = new TextEncoder().encode(canonicalStr);
  const sigValid = await verify(intent.signature, messageBytes, publicKeyHex);
  if (!sigValid) {
    return { valid: false, reason: 'Ed25519 signature verification failed' };
  }

  return { valid: true, reason: 'Signature valid' };
}

export function isIntentExpired(intent: { expires_at: string }): boolean {
  return new Date(intent.expires_at) <= new Date();
}
