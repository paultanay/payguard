import { describe, it, expect } from 'vitest';
import { createSignedIntent, verifyIntentSignature, isIntentExpired } from '../../src/intent/model.js';
import { getKeyPair } from '../../src/crypto/keys.js';

describe('Payment Intent', () => {
  describe('createSignedIntent', () => {
    it('creates an intent with a valid signature', async () => {
      const intent = await createSignedIntent({
        policy_id: 'pol_test',
        agent_id: 'agent_1',
        amount_minor: 1999,
        currency: 'USD',
        payee_id: 'merchant_a',
        description: 'Wireless keyboard',
      }, 1);

      expect(intent.id).toMatch(/^int_/);
      expect(intent.nonce).toBeDefined();
      expect(intent.signature).toBeDefined();
      expect(intent.canonical_hash).toHaveLength(64);
      expect(intent.amount_minor).toBe(1999);
      expect(intent.state).toBe('PROPOSED');
    });

    it('uses integer minor units (no floating point)', async () => {
      const intent = await createSignedIntent({
        policy_id: 'pol_test', agent_id: 'agent_1',
        amount_minor: 1234, currency: 'USD',
        payee_id: 'merchant', description: 'test',
      }, 1);
      expect(Number.isInteger(intent.amount_minor)).toBe(true);
      expect(intent.amount_minor).toBe(1234);
    });
  });

  describe('verifyIntentSignature', () => {
    it('verifies a freshly created intent', async () => {
      const { publicKeyHex } = await getKeyPair();
      const intent = await createSignedIntent({
        policy_id: 'pol_1', agent_id: 'agent_1',
        amount_minor: 500, currency: 'USD',
        payee_id: 'merchant', description: 'test',
      }, 1);

      const result = await verifyIntentSignature(intent, publicKeyHex);
      expect(result.valid).toBe(true);
    });

    it('fails when amount is tampered', async () => {
      const { publicKeyHex } = await getKeyPair();
      const intent = await createSignedIntent({
        policy_id: 'pol_1', agent_id: 'agent_1',
        amount_minor: 500, currency: 'USD',
        payee_id: 'merchant', description: 'test',
      }, 1);

      // Tamper
      const tampered = { ...intent, amount_minor: 999999 };
      const result = await verifyIntentSignature(tampered, publicKeyHex);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('tampered');
    });

    it('fails when payee is tampered', async () => {
      const { publicKeyHex } = await getKeyPair();
      const intent = await createSignedIntent({
        policy_id: 'pol_1', agent_id: 'agent_1',
        amount_minor: 500, currency: 'USD',
        payee_id: 'merchant_a', description: 'test',
      }, 1);

      const tampered = { ...intent, payee_id: 'evil_merchant' };
      const result = await verifyIntentSignature(tampered, publicKeyHex);
      expect(result.valid).toBe(false);
    });

    it('fails when description is tampered', async () => {
      const { publicKeyHex } = await getKeyPair();
      const intent = await createSignedIntent({
        policy_id: 'pol_1', agent_id: 'agent_1',
        amount_minor: 500, currency: 'USD',
        payee_id: 'merchant', description: 'keyboard',
      }, 1);

      const tampered = { ...intent, description: 'Expensive jewelry' };
      const result = await verifyIntentSignature(tampered, publicKeyHex);
      expect(result.valid).toBe(false);
    });

    it('fails with wrong public key', async () => {
      const intent = await createSignedIntent({
        policy_id: 'pol_1', agent_id: 'agent_1',
        amount_minor: 500, currency: 'USD',
        payee_id: 'merchant', description: 'test',
      }, 1);

      const wrongKey = '0'.repeat(64);
      const result = await verifyIntentSignature(intent, wrongKey);
      expect(result.valid).toBe(false);
    });
  });

  describe('expiration', () => {
    it('detects an expired intent', () => {
      const expired = { expires_at: new Date(Date.now() - 1000).toISOString() };
      expect(isIntentExpired(expired)).toBe(true);
    });

    it('valid intent is not expired', () => {
      const valid = { expires_at: new Date(Date.now() + 60000).toISOString() };
      expect(isIntentExpired(valid)).toBe(false);
    });
  });
});
