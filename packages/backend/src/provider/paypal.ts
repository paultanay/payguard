/**
 * PayPal Sandbox Provider Adapter
 *
 * Uses PayPal Orders v2 API.
 * Flow: Create Order (intent=CAPTURE) → Buyer approves → Capture
 *
 * Never uses live credentials. Sandbox only.
 * Never silently switches to live mode.
 * Secrets are never logged or returned in API responses.
 */

import type {
  PaymentProvider,
  CreateOrderRequest,
  CreateOrderResult,
  CaptureOrderRequest,
  CaptureOrderResult,
  GetOrderResult,
} from './interface.js';

const SANDBOX_BASE = 'https://api-m.sandbox.paypal.com';
const LIVE_BASE = 'https://api-m.paypal.com';

export class PayPalAdapter implements PaymentProvider {
  readonly mode = 'sandbox' as const;
  private accessToken: string | null = null;
  private tokenExpiry: number = 0;

  constructor(
    private clientId: string,
    private clientSecret: string,
    private baseUrl: string = SANDBOX_BASE,
  ) {
    // Refuse to use live base URL
    if (baseUrl === LIVE_BASE || baseUrl.includes('api-m.paypal.com') && !baseUrl.includes('sandbox')) {
      throw new Error('PayGuard refuses to use live PayPal credentials. Use sandbox only.');
    }
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiry - 60_000) {
      return this.accessToken;
    }

    const credentials = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const response = await fetch(`${this.baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`PayPal auth failed: ${response.status} — ${body.slice(0, 200)}`);
    }

    const data = await response.json() as { access_token: string; expires_in: number };
    this.accessToken = data.access_token;
    this.tokenExpiry = Date.now() + data.expires_in * 1000;
    return this.accessToken;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<{ status: number; data: T }> {
    const token = await this.getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (idempotencyKey) {
      headers['PayPal-Request-Id'] = idempotencyKey;
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });

    let data: T;
    const text = await response.text();
    try {
      data = JSON.parse(text) as T;
    } catch {
      data = text as unknown as T;
    }

    return { status: response.status, data };
  }

  async createOrder(req: CreateOrderRequest): Promise<CreateOrderResult> {
    // Convert minor units to decimal string
    const decimalAmount = minorToDecimal(req.amount_minor, req.currency);

    const orderPayload = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: req.intent_id,
          description: req.description.slice(0, 127),
          amount: {
            currency_code: req.currency,
            value: decimalAmount,
          },
          payee: {
            merchant_id: req.payee_id,
          },
        },
      ],
      application_context: {
        return_url: req.return_url,
        cancel_url: req.cancel_url,
        brand_name: 'PayGuard',
        user_action: 'PAY_NOW',
      },
    };

    try {
      const { status, data } = await this.request<Record<string, unknown>>(
        'POST',
        '/v2/checkout/orders',
        orderPayload,
        req.idempotency_key,
      );

      if (status === 201 && data.id) {
        const links = data.links as Array<{ rel: string; href: string }> | undefined;
        const approvalUrl = links?.find((l) => l.rel === 'approve')?.href;
        return {
          success: true,
          provider_order_id: data.id as string,
          approval_url: approvalUrl,
          raw_response: sanitizeResponse(data),
        };
      }

      return {
        success: false,
        error_code: (data.name as string) ?? `HTTP_${status}`,
        error_message: (data.message as string) ?? `Unexpected status ${status}`,
        raw_response: sanitizeResponse(data),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = message.includes('timeout') || message.includes('TimeoutError');
      return {
        success: false,
        error_code: isTimeout ? 'PROVIDER_TIMEOUT' : 'NETWORK_ERROR',
        error_message: isTimeout ? 'PayPal request timed out — outcome unknown' : message,
      };
    }
  }

  async captureOrder(req: CaptureOrderRequest): Promise<CaptureOrderResult> {
    try {
      const { status, data } = await this.request<Record<string, unknown>>(
        'POST',
        `/v2/checkout/orders/${req.provider_order_id}/capture`,
        {},
        req.idempotency_key,
      );

      if (status === 201 && data.status === 'COMPLETED') {
        const captures = (data.purchase_units as Array<{ payments?: { captures?: Array<{ id: string; amount: { value: string; currency_code: string } }> } }>)?.[0]?.payments?.captures;
        const capture = captures?.[0];
        return {
          success: true,
          capture_id: capture?.id,
          status: data.status as string,
          amount_minor: capture ? decimalToMinor(capture.amount.value, capture.amount.currency_code) : undefined,
          currency: capture?.amount.currency_code,
          raw_response: sanitizeResponse(data),
        };
      }

      // 422 UNPROCESSABLE_ENTITY with ORDER_ALREADY_CAPTURED is idempotent success
      if (status === 422) {
        const details = data.details as Array<{ issue: string }> | undefined;
        if (details?.some((d) => d.issue === 'ORDER_ALREADY_CAPTURED')) {
          return {
            success: true,
            status: 'COMPLETED',
            raw_response: sanitizeResponse(data),
          };
        }
      }

      return {
        success: false,
        error_code: (data.name as string) ?? `HTTP_${status}`,
        error_message: (data.message as string) ?? `Unexpected status ${status}`,
        raw_response: sanitizeResponse(data),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isTimeout = message.includes('timeout') || message.includes('TimeoutError');
      return {
        success: false,
        error_code: isTimeout ? 'PROVIDER_TIMEOUT' : 'NETWORK_ERROR',
        error_message: isTimeout ? 'PayPal capture timed out — outcome unknown' : message,
      };
    }
  }

  async getOrder(providerOrderId: string): Promise<GetOrderResult> {
    try {
      const { status, data } = await this.request<Record<string, unknown>>(
        'GET',
        `/v2/checkout/orders/${providerOrderId}`,
      );

      if (status === 200) {
        const unit = (data.purchase_units as Array<{ amount: { value: string; currency_code: string } }>)?.[0];
        return {
          found: true,
          status: data.status as string,
          amount_minor: unit ? decimalToMinor(unit.amount.value, unit.amount.currency_code) : undefined,
          currency: unit?.amount.currency_code,
          raw_response: sanitizeResponse(data),
        };
      }

      return { found: false, error_code: `HTTP_${status}`, raw_response: sanitizeResponse(data) };
    } catch {
      return { found: false, error_code: 'NETWORK_ERROR' };
    }
  }
}

/** Convert integer minor units to decimal string for PayPal API. */
function minorToDecimal(minorUnits: number, currency: string): string {
  const decimals = currencyDecimals(currency);
  return (minorUnits / Math.pow(10, decimals)).toFixed(decimals);
}

/** Convert PayPal decimal string to integer minor units. */
function decimalToMinor(value: string, currency: string): number {
  const decimals = currencyDecimals(currency);
  return Math.round(parseFloat(value) * Math.pow(10, decimals));
}

/** Currency-specific decimal places. */
function currencyDecimals(currency: string): number {
  const zero = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);
  const three = new Set(['BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND']);
  if (zero.has(currency)) return 0;
  if (three.has(currency)) return 3;
  return 2;
}

/** Remove sensitive fields from provider responses before storing/returning. */
function sanitizeResponse(data: Record<string, unknown>): Record<string, unknown> {
  const cleaned = { ...data };
  delete cleaned.payer; // may contain personal info
  return cleaned;
}
