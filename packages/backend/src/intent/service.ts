/**
 * Intent Service — orchestrates the full payment proposal lifecycle.
 *
 * Flow:
 *  1. Create signed intent
 *  2. Check idempotency (duplicate suppression)
 *  3. Verify signature
 *  4. Check expiration
 *  5. Check nonce (replay prevention)
 *  6. Evaluate policy (deterministic)
 *  7. Reserve budget (atomic)
 *  8. Create transaction record
 *  9. Record audit event
 * 10. Execute provider (PayPal or simulator)
 * 11. Update state + release/consume reservation
 */

import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { type CreateIntentInput, createSignedIntent, verifyIntentSignature, isIntentExpired, type SignedIntent } from './model.js';
import { PolicyEngine } from '../policy/engine.js';
import { BudgetService } from '../budget/service.js';
import { ApprovalService } from '../approval/service.js';
import { AuditService } from '../audit/service.js';
import { validateTransition } from '../state-machine/transitions.js';
import { getKeyPair } from '../crypto/keys.js';
import { sha256, canonicalJson } from '../crypto/hash.js';
import type { PaymentProvider } from '../provider/interface.js';

export interface ExecutePaymentRequest {
  intent_id: string;
  return_url?: string;
  cancel_url?: string;
}

export interface ExecutePaymentResult {
  success: boolean;
  state: string;
  transaction_id?: string;
  provider_order_id?: string;
  approval_url?: string;
  capture_id?: string;
  error?: string;
  provider_mode: string;
}

export interface IntentRow {
  id: string;
  policy_id: string;
  agent_id: string;
  nonce: string;
  idempotency_key: string;
  canonical_hash: string;
  signature: string;
  amount_minor: number;
  currency: string;
  payee_id: string;
  payee_name: string | null;
  description: string;
  operation: string;
  state: string;
  policy_version: number;
  created_at: string;
  expires_at: string;
  updated_at: string;
  metadata: string;
}

export interface TransactionRow {
  id: string;
  intent_id: string;
  provider_id: string | null;
  provider_mode: string;
  state: string;
  amount_minor: number;
  currency: string;
  payee_id: string;
  payee_name: string | null;
  approval_id: string | null;
  reservation_id: string | null;
  provider_response: string | null;
  error_code: string | null;
  created_at: string;
  updated_at: string;
}

export class IntentService {
  private policyEngine: PolicyEngine;
  private budgetService: BudgetService;
  private approvalService: ApprovalService;
  private auditService: AuditService;

  constructor(
    private db: Database.Database,
    private provider: PaymentProvider,
  ) {
    this.policyEngine = new PolicyEngine(db);
    this.budgetService = new BudgetService(db);
    this.approvalService = new ApprovalService(db);
    this.auditService = new AuditService(db);
  }

  async createIntent(input: CreateIntentInput): Promise<{
    intent: SignedIntent;
    decision: string;
    reason: string;
    approval_id?: string;
    idempotent: boolean;
  }> {
    // --- Idempotency check ---
    const idempotencyKey = input.idempotency_key ?? undefined;
    if (idempotencyKey) {
      const existing = this.db.prepare(
        'SELECT intent_id FROM idempotency_records WHERE idem_key = ?'
      ).get(idempotencyKey) as { intent_id: string } | undefined;

      if (existing) {
        const existingIntent = this.getIntent(existing.intent_id);
        if (existingIntent) {
          const policy = this.policyEngine.getPolicyById(existingIntent.policy_id);
          const intent = rowToSignedIntent(existingIntent, policy?.version ?? 1);
          return { intent, decision: 'IDEMPOTENT', reason: 'Duplicate request — returning existing intent', idempotent: true };
        }
      }
    }

    // --- Get policy ---
    const policy = this.policyEngine.getPolicyById(input.policy_id);
    if (!policy) throw new Error('Policy not found: ' + input.policy_id);

    // --- Create and sign intent ---
    const signed = await createSignedIntent(input, policy.version);

    // --- Store intent ---
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO payment_intents
        (id, policy_id, agent_id, nonce, idempotency_key, canonical_hash, signature,
         amount_minor, currency, payee_id, payee_name, description, operation, state,
         policy_version, created_at, expires_at, updated_at, metadata)
      VALUES
        (@id, @policy_id, @agent_id, @nonce, @idempotency_key, @canonical_hash, @signature,
         @amount_minor, @currency, @payee_id, @payee_name, @description, @operation, @state,
         @policy_version, @created_at, @expires_at, @updated_at, @metadata)
    `).run({
      ...signed,
      payee_name: signed.payee_name ?? null,
      state: 'PROPOSED',
      metadata: JSON.stringify(signed.metadata ?? {}),
    });

    // --- Store idempotency record ---
    if (idempotencyKey) {
      const responseHash = sha256(canonicalJson({ intent_id: signed.id }));
      this.db.prepare(
        'INSERT OR IGNORE INTO idempotency_records (idem_key, intent_id, response_hash, created_at) VALUES (?, ?, ?, ?)'
      ).run(idempotencyKey, signed.id, responseHash, now);
    }

    // --- Audit ---
    this.auditService.record('INTENT_CREATED', signed.id, 'intent', {
      policy_id: signed.policy_id,
      agent_id: signed.agent_id,
      amount_minor: signed.amount_minor,
      currency: signed.currency,
      payee_id: signed.payee_id,
    }, signed.agent_id);

    // --- Policy evaluation ---
    const evalResult = this.policyEngine.evaluate({
      policy_id: input.policy_id,
      agent_id: input.agent_id,
      operation: input.operation ?? 'purchase',
      amount_minor: input.amount_minor,
      currency: input.currency,
      payee_id: input.payee_id,
    });

    this.auditService.record(
      evalResult.decision === 'DENY' ? 'POLICY_DENIED' : 'POLICY_EVALUATED',
      signed.id,
      'intent',
      { decision: evalResult.decision, reason: evalResult.reason },
      'policy_engine',
    );

    if (evalResult.decision === 'DENY') {
      this.updateIntentState(signed.id, 'FAILED', now);
      return { intent: signed, decision: 'DENY', reason: evalResult.reason, idempotent: false };
    }

    if (evalResult.decision === 'REQUIRE_APPROVAL') {
      const approval = this.approvalService.createApproval(signed.id, policy.version, {
        amount_minor: signed.amount_minor,
        currency: signed.currency,
        payee_id: signed.payee_id,
        description: signed.description,
      });
      this.updateIntentState(signed.id, 'PENDING_APPROVAL', now);
      this.auditService.record('APPROVAL_REQUESTED', signed.id, 'intent', {
        approval_id: approval.id,
      }, 'policy_engine');
      return { intent: signed, decision: 'REQUIRE_APPROVAL', reason: evalResult.reason, approval_id: approval.id, idempotent: false };
    }

    return { intent: signed, decision: 'ALLOW', reason: evalResult.reason, idempotent: false };
  }

  async executePayment(req: ExecutePaymentRequest): Promise<ExecutePaymentResult> {
    const intentRow = this.getIntent(req.intent_id);
    if (!intentRow) {
      return { success: false, state: 'ERROR', error: 'Intent not found', provider_mode: this.provider.mode };
    }

    const { publicKeyHex } = await getKeyPair();
    const policy = this.policyEngine.getPolicyById(intentRow.policy_id);
    const intent = rowToSignedIntent(intentRow, policy?.version ?? intentRow.policy_version);

    // --- Check expiration FIRST (uses raw DB field, before signature verify) ---
    if (new Date(intentRow.expires_at) <= new Date()) {
      this.updateIntentState(intent.id, 'EXPIRED', new Date().toISOString());
      this.auditService.record('INTENT_EXPIRED', intent.id, 'intent', {}, 'gateway');
      return { success: false, state: 'EXPIRED', error: 'Intent has expired', provider_mode: this.provider.mode };
    }

    // --- Replay check ---
    if (intentRow.state === 'SUCCEEDED') {
      this.auditService.record('REPLAY_REJECTED', intent.id, 'intent', { reason: 'Already succeeded' }, 'gateway');
      return { success: false, state: 'REPLAY', error: 'Intent has already been executed', provider_mode: this.provider.mode };
    }

    if (!['PROPOSED', 'RESERVED', 'PENDING_APPROVAL'].includes(intentRow.state)) {
      return { success: false, state: intentRow.state, error: `Intent is in state ${intentRow.state}`, provider_mode: this.provider.mode };
    }

    // --- Verify signature ---
    const sigResult = await verifyIntentSignature(intent, publicKeyHex);
    this.auditService.record(
      sigResult.valid ? 'SIGNATURE_VERIFIED' : 'SIGNATURE_FAILED',
      intent.id, 'intent',
      { reason: sigResult.reason },
      'gateway',
    );
    if (!sigResult.valid) {
      return { success: false, state: 'FAILED', error: `Signature invalid: ${sigResult.reason}`, provider_mode: this.provider.mode };
    }
    // --- Check approval if required ---
    if (intentRow.state === 'PENDING_APPROVAL') {
      const approval = this.approvalService.getPendingApprovalForIntent(intent.id);
      if (!approval) {
        const anyApproval = this.db.prepare(
          "SELECT status FROM approvals WHERE intent_id = ? ORDER BY created_at DESC LIMIT 1"
        ).get(intent.id) as { status: string } | undefined;

        if (anyApproval?.status === 'approved') {
          // OK, proceed
        } else {
          return { success: false, state: 'PENDING_APPROVAL', error: 'Awaiting human approval', provider_mode: this.provider.mode };
        }
      } else {
        return { success: false, state: 'PENDING_APPROVAL', error: 'Awaiting human approval', provider_mode: this.provider.mode };
      }
    }

    // --- Atomic budget reservation ---
    const reserveResult = this.budgetService.reserve(
      intent.id, intent.policy_id, intent.amount_minor, intent.currency
    );

    this.auditService.record(
      reserveResult.success ? 'BUDGET_RESERVED' : 'BUDGET_INSUFFICIENT',
      intent.id, 'intent',
      { amount_minor: intent.amount_minor, success: reserveResult.success, reason: reserveResult.reason },
      'budget_service',
    );

    if (!reserveResult.success) {
      this.updateIntentState(intent.id, 'FAILED', new Date().toISOString());
      return { success: false, state: 'FAILED', error: `Budget reservation failed: ${reserveResult.reason}`, provider_mode: this.provider.mode };
    }

    this.updateIntentState(intent.id, 'RESERVED', new Date().toISOString());

    // --- Create transaction record ---
    const txnId = `txn_${nanoid(16)}`;
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO transactions
        (id, intent_id, provider_id, provider_mode, state, amount_minor, currency, payee_id, payee_name,
         approval_id, reservation_id, created_at, updated_at)
      VALUES
        (@id, @intent_id, null, @provider_mode, 'RESERVED', @amount_minor, @currency, @payee_id, @payee_name,
         null, @reservation_id, @created_at, @updated_at)
    `).run({
      id: txnId,
      intent_id: intent.id,
      provider_mode: this.provider.mode,
      amount_minor: intent.amount_minor,
      currency: intent.currency,
      payee_id: intent.payee_id,
      payee_name: intent.payee_name ?? null,
      reservation_id: reserveResult.reservation!.id,
      created_at: now,
      updated_at: now,
    });

    // --- Execute provider ---
    const returnUrl = req.return_url ?? `http://localhost:3001/payment/return?intent_id=${intent.id}`;
    const cancelUrl = req.cancel_url ?? `http://localhost:3001/payment/cancel?intent_id=${intent.id}`;

    this.auditService.record('PROVIDER_REQUEST', intent.id, 'intent', {
      provider_mode: this.provider.mode,
      amount_minor: intent.amount_minor,
      currency: intent.currency,
    }, 'gateway');

    const createResult = await this.provider.createOrder({
      intent_id: intent.id,
      idempotency_key: intent.idempotency_key,
      amount_minor: intent.amount_minor,
      currency: intent.currency,
      payee_id: intent.payee_id,
      description: intent.description,
      return_url: returnUrl,
      cancel_url: cancelUrl,
    });

    this.auditService.record('PROVIDER_RESPONSE', intent.id, 'intent', {
      provider_mode: this.provider.mode,
      success: createResult.success,
      error_code: createResult.error_code,
      provider_order_id: createResult.provider_order_id,
    }, 'gateway');

    if (!createResult.success) {
      if (createResult.error_code === 'PROVIDER_TIMEOUT') {
        // Ambiguous outcome — do NOT release budget, enter reconciliation
        this.updateIntentState(intent.id, 'RECONCILIATION_REQUIRED', new Date().toISOString());
        this.updateTransaction(txnId, { state: 'RECONCILIATION_REQUIRED', error_code: createResult.error_code });
        this.auditService.record('RECONCILIATION_REQUIRED', intent.id, 'intent', {
          reason: 'Provider timeout — outcome unknown, reservation held',
        }, 'gateway');
        return { success: false, state: 'RECONCILIATION_REQUIRED', error: createResult.error_message, provider_mode: this.provider.mode };
      }

      // Definitive failure — release reservation
      this.budgetService.release(reserveResult.reservation!.id);
      this.updateIntentState(intent.id, 'FAILED', new Date().toISOString());
      this.updateTransaction(txnId, { state: 'FAILED', error_code: createResult.error_code });
      return { success: false, state: 'FAILED', error: createResult.error_message, provider_mode: this.provider.mode };
    }

    // Update transaction with provider order ID
    this.updateTransaction(txnId, {
      provider_id: createResult.provider_order_id,
      state: 'PAYMENT_PENDING',
    });
    this.updateIntentState(intent.id, 'PAYMENT_PENDING', new Date().toISOString());

    return {
      success: true,
      state: 'PAYMENT_PENDING',
      transaction_id: txnId,
      provider_order_id: createResult.provider_order_id,
      approval_url: createResult.approval_url,
      provider_mode: this.provider.mode,
    };
  }

  async capturePayment(transactionId: string): Promise<ExecutePaymentResult> {
    const txn = this.getTransaction(transactionId);
    if (!txn) {
      return { success: false, state: 'ERROR', error: 'Transaction not found', provider_mode: this.provider.mode };
    }
    if (txn.state === 'SUCCEEDED') {
      return {
        success: true,
        state: 'SUCCEEDED',
        transaction_id: transactionId,
        capture_id: txn.provider_id ?? undefined,
        provider_mode: this.provider.mode,
      };
    }
    if (txn.state !== 'PAYMENT_PENDING') {
      return { success: false, state: txn.state, error: `Cannot capture transaction in state ${txn.state}`, provider_mode: this.provider.mode };
    }
    if (!txn.provider_id) {
      return { success: false, state: 'ERROR', error: 'No provider order ID', provider_mode: this.provider.mode };
    }

    this.auditService.record('PROVIDER_REQUEST', txn.intent_id, 'intent', {
      action: 'capture', provider_order_id: txn.provider_id,
    }, 'gateway');

    const captureResult = await this.provider.captureOrder({
      provider_order_id: txn.provider_id,
      idempotency_key: `cap_${transactionId}`,
    });

    this.auditService.record('PROVIDER_RESPONSE', txn.intent_id, 'intent', {
      action: 'capture',
      success: captureResult.success,
      error_code: captureResult.error_code,
      capture_id: captureResult.capture_id,
    }, 'gateway');

    if (captureResult.success && (
      captureResult.amount_minor !== txn.amount_minor ||
      captureResult.currency !== txn.currency
    )) {
      const reason = 'Provider capture amount or currency does not match the authorized intent';
      this.updateTransaction(transactionId, { state: 'RECONCILIATION_REQUIRED', error_code: 'CAPTURE_DETAILS_MISMATCH' });
      this.updateIntentState(txn.intent_id, 'RECONCILIATION_REQUIRED', new Date().toISOString());
      this.auditService.record('RECONCILIATION_REQUIRED', txn.intent_id, 'intent', {
        reason,
        expected_amount_minor: txn.amount_minor,
        actual_amount_minor: captureResult.amount_minor,
        expected_currency: txn.currency,
        actual_currency: captureResult.currency,
      }, 'gateway');
      return { success: false, state: 'RECONCILIATION_REQUIRED', error: reason, provider_mode: this.provider.mode };
    }

    if (!captureResult.success) {
      if (captureResult.error_code === 'PROVIDER_TIMEOUT') {
        this.updateTransaction(transactionId, { state: 'RECONCILIATION_REQUIRED', error_code: captureResult.error_code });
        this.updateIntentState(txn.intent_id, 'RECONCILIATION_REQUIRED', new Date().toISOString());
        return { success: false, state: 'RECONCILIATION_REQUIRED', error: captureResult.error_message, provider_mode: this.provider.mode };
      }
      this.updateTransaction(transactionId, { state: 'FAILED', error_code: captureResult.error_code });
      this.updateIntentState(txn.intent_id, 'FAILED', new Date().toISOString());
      // Release budget
      if (txn.reservation_id) this.budgetService.release(txn.reservation_id);
      return { success: false, state: 'FAILED', error: captureResult.error_message, provider_mode: this.provider.mode };
    }

    // Consume reservation
    if (txn.reservation_id) {
      this.budgetService.consume(txn.reservation_id, transactionId);
    }

    this.updateTransaction(transactionId, { state: 'SUCCEEDED', provider_id: captureResult.capture_id ?? txn.provider_id });
    this.updateIntentState(txn.intent_id, 'SUCCEEDED', new Date().toISOString());

    this.auditService.record('PAYMENT_STATE_CHANGED', txn.intent_id, 'intent', {
      from: 'PAYMENT_PENDING', to: 'SUCCEEDED',
      capture_id: captureResult.capture_id,
    }, 'gateway');

    return {
      success: true,
      state: 'SUCCEEDED',
      transaction_id: transactionId,
      capture_id: captureResult.capture_id,
      provider_mode: this.provider.mode,
    };
  }

  getIntent(id: string): IntentRow | null {
    return (this.db.prepare('SELECT * FROM payment_intents WHERE id = ?').get(id) as IntentRow) ?? null;
  }

  listIntents(limit = 50, offset = 0): IntentRow[] {
    return this.db.prepare(
      'SELECT * FROM payment_intents ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all(limit, offset) as IntentRow[];
  }

  getTransaction(id: string): TransactionRow | null {
    return (this.db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as TransactionRow) ?? null;
  }

  getTransactionForIntent(intentId: string): TransactionRow | null {
    return (this.db.prepare(
      'SELECT * FROM transactions WHERE intent_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(intentId) as TransactionRow) ?? null;
  }

  listTransactions(limit = 50, offset = 0): TransactionRow[] {
    return this.db.prepare(
      'SELECT * FROM transactions ORDER BY created_at DESC LIMIT ? OFFSET ?'
    ).all(limit, offset) as TransactionRow[];
  }

  private updateIntentState(id: string, state: string, updatedAt: string): void {
    this.db.prepare(
      'UPDATE payment_intents SET state = ?, updated_at = ? WHERE id = ?'
    ).run(state, updatedAt, id);
  }

  private updateTransaction(id: string, updates: Partial<{
    state: string;
    provider_id: string;
    error_code: string;
    provider_response: string;
  }>): void {
    const now = new Date().toISOString();
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];

    if (updates.state !== undefined) { sets.push('state = ?'); params.push(updates.state); }
    if (updates.provider_id !== undefined) { sets.push('provider_id = ?'); params.push(updates.provider_id); }
    if (updates.error_code !== undefined) { sets.push('error_code = ?'); params.push(updates.error_code); }
    if (updates.provider_response !== undefined) { sets.push('provider_response = ?'); params.push(updates.provider_response); }
    params.push(id);

    this.db.prepare(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  }
}

function rowToSignedIntent(row: IntentRow, policyVersion: number): SignedIntent {
  return {
    id: row.id,
    policy_id: row.policy_id,
    policy_version: policyVersion,
    agent_id: row.agent_id,
    nonce: row.nonce,
    idempotency_key: row.idempotency_key,
    canonical_hash: row.canonical_hash,
    signature: row.signature,
    public_key_hex: '', // fetched separately when needed
    amount_minor: row.amount_minor,
    currency: row.currency,
    payee_id: row.payee_id,
    payee_name: row.payee_name ?? undefined,
    description: row.description,
    operation: row.operation,
    state: row.state as never,
    created_at: row.created_at,
    expires_at: row.expires_at,
    updated_at: row.updated_at,
    metadata: JSON.parse(row.metadata ?? '{}'),
  };
}
