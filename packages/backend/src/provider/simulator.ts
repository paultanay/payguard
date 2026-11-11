/**
 * Deterministic Payment Simulator - for offline testing and demos.
 *
 * SIMULATED MODE - no real money moves, no network calls.
 * All results are clearly labeled as simulated.
 * Never represents simulated results as real PayPal transactions.
 */

import { nanoid } from 'nanoid';
import type {
  PaymentProvider,
  CreateOrderRequest,
  CreateOrderResult,
  CaptureOrderRequest,
  CaptureOrderResult,
  GetOrderResult,
} from './interface.js';

type SimulatedOrderState = 'CREATED' | 'APPROVED' | 'COMPLETED' | 'VOIDED' | 'TIMEOUT_PENDING';

interface SimulatedOrder {
  id: string;
  state: SimulatedOrderState;
  amount_minor: number;
  currency: string;
  payee_id: string;
  intent_id: string;
  created_at: string;
}

export type SimulatorBehavior = 'succeed' | 'fail_create' | 'fail_capture' | 'timeout' | 'already_captured';

export class PaymentSimulator implements PaymentProvider {
  readonly mode = 'simulated' as const;
  private orders = new Map<string, SimulatedOrder>();
  private behavior: SimulatorBehavior = 'succeed';

  /** Override behavior for testing adversarial scenarios. */
  setBehavior(b: SimulatorBehavior): void {
    this.behavior = b;
  }

  /** Pre-approve an order (simulates buyer completing PayPal checkout). */
  approveOrder(providerOrderId: string): boolean {
    const order = this.orders.get(providerOrderId);
    if (!order || order.state !== 'CREATED') return false;
    order.state = 'APPROVED';
    return true;
  }

  async createOrder(req: CreateOrderRequest): Promise<CreateOrderResult> {
    if (this.behavior === 'fail_create') {
      return {
        success: false,
        error_code: 'SIMULATED_CREATE_FAILURE',
        error_message: '[SIMULATED] Order creation failed',
        raw_response: { simulated: true },
      };
    }

    if (this.behavior === 'timeout') {
      // Simulate a timeout - return ambiguous result
      return {
        success: false,
        error_code: 'PROVIDER_TIMEOUT',
        error_message: '[SIMULATED] Provider timed out - outcome unknown',
        raw_response: { simulated: true, timeout: true },
      };
    }

    const orderId = `SIM-${nanoid(12).toUpperCase()}`;
    const order: SimulatedOrder = {
      id: orderId,
      state: 'CREATED',
      amount_minor: req.amount_minor,
      currency: req.currency,
      payee_id: req.payee_id,
      intent_id: req.intent_id,
      created_at: new Date().toISOString(),
    };
    this.orders.set(orderId, order);

    // In simulation, automatically approve (no browser redirect needed)
    order.state = 'APPROVED';

    return {
      success: true,
      provider_order_id: orderId,
      approval_url: `http://localhost:3001/simulate/approve/${orderId}`,
      raw_response: {
        simulated: true,
        id: orderId,
        status: 'APPROVED',
        amount: { value: (req.amount_minor / 100).toFixed(2), currency_code: req.currency },
      },
    };
  }

  async captureOrder(req: CaptureOrderRequest): Promise<CaptureOrderResult> {
    const order = this.orders.get(req.provider_order_id);

    if (!order) {
      return {
        success: false,
        error_code: 'ORDER_NOT_FOUND',
        error_message: `[SIMULATED] Order ${req.provider_order_id} not found`,
        raw_response: { simulated: true },
      };
    }

    if (this.behavior === 'already_captured' || order.state === 'COMPLETED') {
      return {
        success: true,
        capture_id: `CAP-${nanoid(12).toUpperCase()}`,
        status: 'COMPLETED',
        amount_minor: order.amount_minor,
        currency: order.currency,
        raw_response: { simulated: true, already_captured: true },
      };
    }

    if (this.behavior === 'fail_capture') {
      return {
        success: false,
        error_code: 'SIMULATED_CAPTURE_FAILURE',
        error_message: '[SIMULATED] Capture failed',
        raw_response: { simulated: true },
      };
    }

    if (order.state !== 'APPROVED') {
      return {
        success: false,
        error_code: 'ORDER_NOT_APPROVED',
        error_message: `[SIMULATED] Order state is ${order.state}, not APPROVED`,
        raw_response: { simulated: true },
      };
    }

    const captureId = `CAP-${nanoid(12).toUpperCase()}`;
    order.state = 'COMPLETED';

    return {
      success: true,
      capture_id: captureId,
      status: 'COMPLETED',
      amount_minor: order.amount_minor,
      currency: order.currency,
      raw_response: {
        simulated: true,
        id: captureId,
        status: 'COMPLETED',
        amount: { value: (order.amount_minor / 100).toFixed(2), currency_code: order.currency },
      },
    };
  }

  async getOrder(providerOrderId: string): Promise<GetOrderResult> {
    const order = this.orders.get(providerOrderId);
    if (!order) {
      return { found: false, error_code: 'ORDER_NOT_FOUND', raw_response: { simulated: true } };
    }
    return {
      found: true,
      status: order.state,
      amount_minor: order.amount_minor,
      currency: order.currency,
      raw_response: { simulated: true, id: order.id, status: order.state },
    };
  }
}
