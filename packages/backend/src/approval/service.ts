import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { sha256, canonicalJson } from '../crypto/hash.js';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface Approval {
  id: string;
  intent_id: string;
  policy_version: number;
  fields_hash: string;
  status: ApprovalStatus;
  approved_by?: string;
  reason?: string;
  created_at: string;
  expires_at: string;
  updated_at: string;
}

export class ApprovalService {
  constructor(private db: Database.Database) {}

  createApproval(intentId: string, policyVersion: number, fields: {
    amount_minor: number;
    currency: string;
    payee_id: string;
    description: string;
  }): Approval {
    const id = `apr_${nanoid(16)}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * 60 * 1000); // 30 min
    const fieldsHash = sha256(canonicalJson(fields as unknown as Record<string, unknown>));

    const approval: Approval = {
      id,
      intent_id: intentId,
      policy_version: policyVersion,
      fields_hash: fieldsHash,
      status: 'pending',
      created_at: now.toISOString(),
      expires_at: expiresAt.toISOString(),
      updated_at: now.toISOString(),
    };

    this.db.prepare(`
      INSERT INTO approvals (id, intent_id, policy_version, fields_hash, status, created_at, expires_at, updated_at)
      VALUES (@id, @intent_id, @policy_version, @fields_hash, @status, @created_at, @expires_at, @updated_at)
    `).run(approval);

    return approval;
  }

  getApproval(id: string): Approval | null {
    return (this.db.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Approval) ?? null;
  }

  getPendingApprovalForIntent(intentId: string): Approval | null {
    const row = this.db.prepare(
      "SELECT * FROM approvals WHERE intent_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1"
    ).get(intentId);
    return (row as Approval) ?? null;
  }

  /**
   * Approve — must match exact fields_hash to prevent authorization of modified transactions.
   */
  approve(id: string, approvedBy: string, fieldsToVerify: {
    amount_minor: number;
    currency: string;
    payee_id: string;
    description: string;
  }): { success: boolean; reason: string } {
    const approval = this.getApproval(id);
    if (!approval) return { success: false, reason: 'Approval not found' };
    if (approval.status !== 'pending') return { success: false, reason: `Approval is ${approval.status}` };
    if (new Date(approval.expires_at) <= new Date()) {
      this.expire(id);
      return { success: false, reason: 'Approval has expired' };
    }

    const fieldsHash = sha256(canonicalJson(fieldsToVerify as unknown as Record<string, unknown>));
    if (fieldsHash !== approval.fields_hash) {
      return {
        success: false,
        reason: 'Approval fields mismatch — transaction details changed, reauthorization required',
      };
    }

    const now = new Date().toISOString();
    this.db.prepare(
      "UPDATE approvals SET status = 'approved', approved_by = ?, updated_at = ? WHERE id = ?"
    ).run(approvedBy, now, id);
    return { success: true, reason: 'Approved' };
  }

  reject(id: string, reason: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      "UPDATE approvals SET status = 'rejected', reason = ?, updated_at = ? WHERE id = ? AND status = 'pending'"
    ).run(reason, now, id);
    return result.changes > 0;
  }

  expire(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.prepare(
      "UPDATE approvals SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending'"
    ).run(now, id);
    return result.changes > 0;
  }

  listPendingApprovals(): Approval[] {
    return this.db.prepare(
      "SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at DESC"
    ).all() as Approval[];
  }
}
