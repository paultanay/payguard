import { describe, it, expect } from 'vitest';
import { sha256, canonicalJson } from '../../src/crypto/hash.js';
import { sign, verify, getKeyPair, hexToBytes, bytesToHex } from '../../src/crypto/keys.js';

describe('SHA-256 hash', () => {
  it('produces consistent output for same input', () => {
    expect(sha256('hello')).toBe(sha256('hello'));
  });

  it('differs for different inputs', () => {
    expect(sha256('hello')).not.toBe(sha256('world'));
  });

  it('produces 64-character hex string', () => {
    expect(sha256('test')).toHaveLength(64);
  });
});

describe('canonicalJson', () => {
  it('sorts keys deterministically', () => {
    const a = canonicalJson({ z: 1, a: 2 });
    const b = canonicalJson({ a: 2, z: 1 });
    expect(a).toBe(b);
  });

  it('nested objects are also sorted', () => {
    const a = canonicalJson({ outer: { z: 1, a: 2 } });
    const b = canonicalJson({ outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });

  it('different values produce different output', () => {
    const a = canonicalJson({ amount: 100 });
    const b = canonicalJson({ amount: 200 });
    expect(a).not.toBe(b);
  });

  it('tampered amount changes canonical hash', () => {
    const original = sha256(canonicalJson({ amount_minor: 1000, currency: 'USD', payee: 'merchant_a' }));
    const tampered = sha256(canonicalJson({ amount_minor: 9999999, currency: 'USD', payee: 'merchant_a' }));
    expect(original).not.toBe(tampered);
  });
});

describe('Ed25519 signing', () => {
  it('sign and verify round-trip succeeds', async () => {
    const { publicKeyHex } = await getKeyPair();
    const message = new TextEncoder().encode('test message');
    const sig = await sign(message);
    const valid = await verify(sig, message, publicKeyHex);
    expect(valid).toBe(true);
  });

  it('signature fails with wrong key', async () => {
    const message = new TextEncoder().encode('test');
    const sig = await sign(message);
    // Use a different (random) public key
    const wrongKey = bytesToHex(new Uint8Array(32).fill(0xff));
    const valid = await verify(sig, message, wrongKey);
    expect(valid).toBe(false);
  });

  it('signature fails with tampered message', async () => {
    const { publicKeyHex } = await getKeyPair();
    const original = new TextEncoder().encode('amount=100');
    const sig = await sign(original);
    const tampered = new TextEncoder().encode('amount=9999999');
    const valid = await verify(sig, tampered, publicKeyHex);
    expect(valid).toBe(false);
  });
});
