/**
 * Payment Provider Interface - common contract for PayPal and Simulator adapters.
 * The provider is replaceable; all authorization logic lives in the backend.
 */

export type ProviderMode = 'sandbox' | 'simulated';

export interface CreateOrderRequest {
  intent_id: string;
  idempotency_key: string;
  amount_minor: number;
  currency: string;
  payee_id: string;
  description: string;
  return_url: string;
  cancel_url: string;
}

export interface CreateOrderResult {
  success: boolean;
  provider_order_id?: string;
  approval_url?: string;
  error_code?: string;
  error_message?: string;
  raw_response?: Record<string, unknown>;
}

export interface CaptureOrderRequest {
  provider_order_id: string;
  idempotency_key: string;
}

export interface CaptureOrderResult {
  success: boolean;
  capture_id?: string;
  status?: string;
  amount_minor?: number;
  currency?: string;
  error_code?: string;
  error_message?: string;
  raw_response?: Record<string, unknown>;
}

export interface GetOrderResult {
  found: boolean;
  status?: string;
  amount_minor?: number;
  currency?: string;
  error_code?: string;
  raw_response?: Record<string, unknown>;
}

export interface PaymentProvider {
  mode: ProviderMode;

  createOrder(req: CreateOrderRequest): Promise<CreateOrderResult>;
  captureOrder(req: CaptureOrderRequest): Promise<CaptureOrderResult>;
  getOrder(providerOrderId: string): Promise<GetOrderResult>;
}
