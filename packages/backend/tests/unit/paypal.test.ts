import { afterEach, describe, expect, it, vi } from 'vitest';
import { PayPalAdapter } from '../../src/provider/paypal.js';

afterEach(() => vi.unstubAllGlobals());

describe('PayPal Sandbox adapter', () => {
  it('rejects non-Sandbox API hosts', () => {
    expect(() => new PayPalAdapter('client', 'secret', 'https://api-m.paypal.com')).toThrow(/official PayPal Sandbox URL/);
    expect(() => new PayPalAdapter('client', 'secret', 'https://attacker.example')).toThrow(/official PayPal Sandbox URL/);
  });

  it('sends an email payee as email_address and returns the approval link', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith('/v1/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'sandbox-token', expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({
        id: 'ORDER-123',
        links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-123' }],
      }), { status: 201 });
    });

    const adapter = new PayPalAdapter('client', 'secret');
    const result = await adapter.createOrder({
      intent_id: 'int_test', idempotency_key: 'idem_test', amount_minor: 1999,
      currency: 'USD', payee_id: 'merchant@example.test', description: 'Keyboard',
      return_url: 'http://localhost:5173/transactions?payment=returned',
      cancel_url: 'http://localhost:5173/transactions?payment=cancelled',
    });

    const payload = JSON.parse(String(requests[1].init?.body));
    expect(payload.purchase_units[0].payee).toEqual({ email_address: 'merchant@example.test' });
    expect(result.success).toBe(true);
    expect(result.provider_order_id).toBe('ORDER-123');
    expect(result.approval_url).toContain('sandbox.paypal.com');
  });
});
