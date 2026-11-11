/**
 * Ed25519 key management for PayGuard.
 * Keys are held in-memory, loaded from environment variables at startup.
 * The signing key is NEVER returned in API responses.
 *
 * What a signature proves:
 *   - A party holding the private key signed these exact canonical fields.
 *   - The fields have not been tampered with since signing.
 *
 * What a signature does NOT prove:
 *   - The identity of a human user.
 *   - Legal non-repudiation.
 *   - Authorization by an external identity provider.
 */

import * as ed from '@noble/ed25519';

export interface KeyPair {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  publicKeyHex: string;
}

let _keyPair: KeyPair | null = null;

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw new Error('Invalid hexadecimal string');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function getKeyPair(): Promise<KeyPair> {
  if (_keyPair) return _keyPair;

  const envPrivKey = process.env.PAYGUARD_SIGNING_KEY;
  let privateKey: Uint8Array;

  if (envPrivKey) {
    if (!/^[0-9a-f]{64}$/i.test(envPrivKey)) {
      throw new Error('PAYGUARD_SIGNING_KEY must contain exactly 64 hexadecimal characters');
    }
    privateKey = hexToBytes(envPrivKey);
  } else {
    // Generate a new key (ephemeral for dev; warn in production)
    privateKey = ed.utils.randomPrivateKey();
    if (process.env.NODE_ENV === 'production') {
      console.warn('[PayGuard] WARNING: No PAYGUARD_SIGNING_KEY set. Using ephemeral key - signatures will not survive restart.');
    }
  }

  const publicKey = await ed.getPublicKeyAsync(privateKey);
  _keyPair = {
    privateKey,
    publicKey,
    publicKeyHex: bytesToHex(publicKey),
  };
  return _keyPair;
}

export async function sign(message: Uint8Array): Promise<string> {
  const { privateKey } = await getKeyPair();
  const sig = await ed.signAsync(message, privateKey);
  return bytesToHex(sig);
}

export async function verify(
  signatureHex: string,
  message: Uint8Array,
  publicKeyHex: string,
): Promise<boolean> {
  try {
    const sig = hexToBytes(signatureHex);
    const pub = hexToBytes(publicKeyHex);
    return await ed.verifyAsync(sig, message, pub);
  } catch {
    return false;
  }
}

export { bytesToHex, hexToBytes };
