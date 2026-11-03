/**
 * Budget Reservation Service
 *
 * CORE INVARIANT: committed_spend + outstanding_reservations <= budget_limit
 *
 * This is enforced via a single atomic SQLite UPDATE:
 *
 *   UPDATE policies
 *   SET remaining_budget_minor = remaining_budget_minor - :amount
 *   WHERE id = :policy_id
 *     AND remaining_budget_minor >= :amount
 *     AND status = 'active'
 *
 * Inside a BEGIN IMMEDIATE transaction (writer lock).
 * If the UPDATE changes 0 rows, the budget was insufficient — reservation FAILS.
 * The provider is NEVER called if reservation fails.
 *
 * Limitation: This guarantee holds within a single SQLite file / single process.
 * Multi-instance deployments are NOT safe without an external lock or a
 * distributed database. This limitation is documented.
 */

import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { computePeriodKey } from '../policy/model.js';

export type ReservationStatus = 'reserved' | 'consumed' | 'released' | 'failed';

export interface BudgetReservation {
  id: string;
  intent_id: string;
  policy_id: string;
  period_key: string;
  amount_minor: number;
  currency: string;
  status: ReservationStatus;
  created_at: string;
  updated_at: string;
  transaction_id: string | null;
}

export interface ReserveResult {
  success: boolean;
  reservation?: BudgetReservation;
  reason?: string;
}

export class BudgetService {
  constructor(private db: Database.Database) {}

  /**
   * Atomically reserve budget for an intent.
   * Returns success=false if budget is insufficient or policy is invalid.
   * Uses BEGIN IMMEDIATE to acquire a writer lock before the UPDATE.
   */
  reserve(
    intentId: string,
    policyId: string,
    amountMinor: number,
    currency: string,
  ): ReserveResult {
    const id = `res_${nanoid(16)}`;
    const now = new Date().toISOString();

    // BEGIN IMMEDIATE acquires the write lock immediately, preventing
    // concurrent writers from reading stale remaining_budget_minor values.
    const atomicReserve = this.db.transaction(() => {
      // Get current policy to determine period key
      const policy = this.db.prepare(
        'SELECT budget_period, budget_period_key, remaining_budget_minor, status, currency FROM policies WHERE id = ?'
      ).get(policyId) as {
        budget_period: string;
        budget_period_key: string;
        remaining_budget_minor: number;
        status: string;
        currency: string;
      } | undefined;

      if (!policy) {
        return { success: false as const, reason: 'Policy not found' };
      }
      if (policy.status !== 'active') {
        return { success: false as const, reason: `Policy is ${policy.status}` };
      }
      if (policy.currency !== currency) {
        return { success: false as const, reason: `Currency mismatch: policy=${policy.currency}` };
      }

      const currentPeriodKey = computePeriodKey(policy.budget_period as never);

      // If the budget period has rolled over, reset remaining_budget_minor first
      if (currentPeriodKey !== policy.budget_period_key) {
        this.db.prepare(`
          UPDATE policies
          SET remaining_budget_minor = budget_limit_minor, budget_period_key = ?
          WHERE id = ?
        `).run(currentPeriodKey, policyId);
        // Re-fetch
        const refreshed = this.db.prepare(
          'SELECT budget_limit_minor, remaining_budget_minor FROM policies WHERE id = ?'
        ).get(policyId) as { budget_limit_minor: number; remaining_budget_minor: number };

        // Now atomically deduct
        const result = this.db.prepare(`
          UPDATE policies
          SET remaining_budget_minor = remaining_budget_minor - ?,
              updated_at = ?
          WHERE id = ?
            AND remaining_budget_minor >= ?
            AND status = 'active'
        `).run(amountMinor, now, policyId, amountMinor);

        if (result.changes === 0) {
          return {
            success: false as const,
            reason: `Insufficient budget after period reset: ${refreshed.remaining_budget_minor} < ${amountMinor}`,
          };
        }
      } else {
        // Standard atomic deduction
        const result = this.db.prepare(`
          UPDATE policies
          SET remaining_budget_minor = remaining_budget_minor - ?,
              updated_at = ?
          WHERE id = ?
            AND remaining_budget_minor >= ?
            AND status = 'active'
        `).run(amountMinor, now, policyId, amountMinor);

        if (result.changes === 0) {
          return {
            success: false as const,
            reason: `Insufficient budget: remaining=${policy.remaining_budget_minor}, requested=${amountMinor}`,
          };
        }
      }

      // Insert the reservation record
      const reservation: BudgetReservation = {
        id,
        intent_id: intentId,
        policy_id: policyId,
        period_key: currentPeriodKey,
        amount_minor: amountMinor,
        currency,
        status: 'reserved',
        created_at: now,
        updated_at: now,
        transaction_id: null,
      };

      this.db.prepare(`
        INSERT INTO budget_reservations
          (id, intent_id, policy_id, period_key, amount_minor, currency, status, created_at, updated_at, transaction_id)
        VALUES
          (@id, @intent_id, @policy_id, @period_key, @amount_minor, @currency, @status, @created_at, @updated_at, @transaction_id)
      `).run(reservation);

      return { success: true as const, reservation };
    });

    // Use BEGIN IMMEDIATE for write lock
    return atomicReserve() as ReserveResult;
  }

  /**
   * Consume a reservation (payment succeeded).
   */
  consume(reservationId: string, transactionId: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE budget_reservations
      SET status = 'consumed', transaction_id = ?, updated_at = ?
      WHERE id = ? AND status = 'reserved'
    `).run(transactionId, now, reservationId);
    return result.changes > 0;
  }

  /**
   * Release a reservation (payment failed, returning budget).
   * Only releases if the reservation is still in 'reserved' state.
   */
  release(reservationId: string): boolean {
    const reservation = this.db.prepare(
      'SELECT * FROM budget_reservations WHERE id = ?'
    ).get(reservationId) as BudgetReservation | undefined;

    if (!reservation || reservation.status !== 'reserved') return false;

    const now = new Date().toISOString();

    const atomicRelease = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE policies
        SET remaining_budget_minor = remaining_budget_minor + ?,
            updated_at = ?
        WHERE id = ?
      `).run(reservation.amount_minor, now, reservation.policy_id);

      this.db.prepare(`
        UPDATE budget_reservations
        SET status = 'released', updated_at = ?
        WHERE id = ?
      `).run(now, reservationId);
    });

    atomicRelease();
    return true;
  }

  getReservation(id: string): BudgetReservation | null {
    const row = this.db.prepare('SELECT * FROM budget_reservations WHERE id = ?').get(id);
    return (row as BudgetReservation) ?? null;
  }

  getReservationForIntent(intentId: string): BudgetReservation | null {
    const row = this.db.prepare(
      "SELECT * FROM budget_reservations WHERE intent_id = ? AND status IN ('reserved', 'consumed')"
    ).get(intentId);
    return (row as BudgetReservation) ?? null;
  }

  getRemainingBudget(policyId: string): number {
    const row = this.db.prepare(
      'SELECT remaining_budget_minor FROM policies WHERE id = ?'
    ).get(policyId) as { remaining_budget_minor: number } | undefined;
    return row?.remaining_budget_minor ?? 0;
  }
}
