/**
 * Audit Service - structured tamper-evident event log.
 *
 * Each event contains:
 *   - Monotonically increasing sequence number
 *   - SHA-256 of the previous event (hash chain)
 *   - SHA-256 of this event's own fields
 *
 * The verifier checks:
 *   1. Each event's own hash matches its fields
 *   2. Each event's prev_hash matches the previous event's event_hash
 *   3. sequence numbers are contiguous
 *
 * Threat model caveat: A party with write access to the DB and the signing
 * key can reconstruct the chain. This detects tampering by external parties
 * or accidental modification, not insider attacks with full DB access.
 */

import type Database from 'better-sqlite3';
import { nanoid } from 'nanoid';
import { sha256, canonicalJson } from '../crypto/hash.js';

export type AuditEventType =
  | 'POLICY_CREATED'
  | 'POLICY_UPDATED'
  | 'POLICY_REVOKED'
  | 'POLICY_ACTIVATED'
  | 'INTENT_CREATED'
  | 'INTENT_VERIFIED'
  | 'INTENT_EXPIRED'
  | 'INTENT_REPLAYED'
  | 'POLICY_EVALUATED'
  | 'POLICY_DENIED'
  | 'APPROVAL_REQUESTED'
  | 'APPROVAL_GRANTED'
  | 'APPROVAL_REJECTED'
  | 'BUDGET_RESERVED'
  | 'BUDGET_RELEASED'
  | 'BUDGET_INSUFFICIENT'
  | 'PAYMENT_STATE_CHANGED'
  | 'PROVIDER_REQUEST'
  | 'PROVIDER_RESPONSE'
  | 'PROVIDER_TIMEOUT'
  | 'RECONCILIATION_REQUIRED'
  | 'RECONCILIATION_RESOLVED'
  | 'SIGNATURE_VERIFIED'
  | 'SIGNATURE_FAILED'
  | 'REPLAY_REJECTED'
  | 'SECURITY_VIOLATION'
  | 'AI_PROPOSAL_CREATED'
  | 'AI_SEMANTIC_CHECK'
  | 'MCP_TOOL_INVOKED'
  | 'AUDIT_VERIFIED'
  | 'ERROR';

export interface AuditEvent {
  id: string;
  sequence_num: number;
  prev_hash: string;
  event_hash: string;
  event_type: AuditEventType;
  entity_id: string;
  entity_type: string;
  actor: string;
  metadata: Record<string, unknown>;
  timestamp: string;
  session_id?: string;
}

export interface VerificationResult {
  valid: boolean;
  total_events: number;
  errors: string[];
  checked_at: string;
}

const GENESIS_HASH = '0'.repeat(64);

export class AuditService {
  private lastHash: string | null = null;
  private lastSeq: number = -1;

  constructor(private db: Database.Database) {
    this.loadState();
  }

  private loadState(): void {
    const last = this.db.prepare(
      'SELECT sequence_num, event_hash FROM audit_events ORDER BY sequence_num DESC LIMIT 1'
    ).get() as { sequence_num: number; event_hash: string } | undefined;

    if (last) {
      this.lastHash = last.event_hash;
      this.lastSeq = last.sequence_num;
    }
  }

  record(
    eventType: AuditEventType,
    entityId: string,
    entityType: string,
    metadata: Record<string, unknown>,
    actor: string = 'system',
    sessionId?: string,
  ): AuditEvent {
    const id = `aud_${nanoid(16)}`;
    const timestamp = new Date().toISOString();

    // Always read the current max sequence from DB to be safe across multiple instances
    const lastRow = this.db.prepare(
      'SELECT sequence_num, event_hash FROM audit_events ORDER BY sequence_num DESC LIMIT 1'
    ).get() as { sequence_num: number; event_hash: string } | undefined;

    const prevHash = lastRow?.event_hash ?? GENESIS_HASH;
    const seqNum = lastRow ? lastRow.sequence_num + 1 : 0;
    this.lastHash = prevHash;
    this.lastSeq = seqNum;

    // Hash covers the canonical representation of all fields
    const hashInput = canonicalJson({
      sequence_num: seqNum,
      prev_hash: prevHash,
      event_type: eventType,
      entity_id: entityId,
      entity_type: entityType,
      actor,
      timestamp,
      // Redact any sensitive metadata fields
      metadata: redactSensitive(metadata),
    });
    const eventHash = sha256(hashInput);

    const event: AuditEvent = {
      id,
      sequence_num: seqNum,
      prev_hash: prevHash,
      event_hash: eventHash,
      event_type: eventType,
      entity_id: entityId,
      entity_type: entityType,
      actor,
      metadata: redactSensitive(metadata),
      timestamp,
      session_id: sessionId,
    };

    this.db.prepare(`
      INSERT INTO audit_events
        (id, sequence_num, prev_hash, event_hash, event_type, entity_id, entity_type, actor, metadata, timestamp, session_id)
      VALUES
        (@id, @sequence_num, @prev_hash, @event_hash, @event_type, @entity_id, @entity_type, @actor, @metadata, @timestamp, @session_id)
    `).run({
      ...event,
      metadata: JSON.stringify(event.metadata),
      session_id: event.session_id ?? null,
    });

    this.lastHash = eventHash;
    this.lastSeq = seqNum;

    return event;
  }

  getEvents(options?: { entity_id?: string; entity_type?: string; limit?: number; offset?: number }): AuditEvent[] {
    let sql = 'SELECT * FROM audit_events';
    const params: unknown[] = [];
    const conditions: string[] = [];

    if (options?.entity_id) {
      conditions.push('entity_id = ?');
      params.push(options.entity_id);
    }
    if (options?.entity_type) {
      conditions.push('entity_type = ?');
      params.push(options.entity_type);
    }
    if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY sequence_num ASC';
    if (options?.limit) {
      sql += ' LIMIT ?';
      params.push(options.limit);
    }
    if (options?.offset) {
      sql += ' OFFSET ?';
      params.push(options.offset);
    }

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map(this.rowToEvent);
  }

  /**
   * Verify the entire audit chain from genesis.
   * Checks:
   * 1. Each event's own hash matches its recorded fields
   * 2. Each event's prev_hash matches the previous event's event_hash
   * 3. Sequence numbers are contiguous from 0
   */
  verify(): VerificationResult {
    const events = this.db.prepare(
      'SELECT * FROM audit_events ORDER BY sequence_num ASC'
    ).all() as Record<string, unknown>[];

    const errors: string[] = [];
    let prevHash = GENESIS_HASH;

    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const seqNum = e.sequence_num as number;

      // Check sequence continuity
      if (seqNum !== i) {
        errors.push(`Gap in sequence: expected ${i}, found ${seqNum}`);
      }

      // Check prev_hash linkage
      if (e.prev_hash !== prevHash) {
        errors.push(`Event #${seqNum}: prev_hash mismatch. Expected ${prevHash.slice(0, 16)}…, got ${(e.prev_hash as string).slice(0, 16)}…`);
      }

      // Recompute event hash
      const hashInput = canonicalJson({
        sequence_num: seqNum,
        prev_hash: e.prev_hash,
        event_type: e.event_type,
        entity_id: e.entity_id,
        entity_type: e.entity_type,
        actor: e.actor,
        timestamp: e.timestamp,
        metadata: JSON.parse(e.metadata as string),
      });
      const expectedHash = sha256(hashInput);

      if (expectedHash !== e.event_hash) {
        errors.push(`Event #${seqNum} (${e.event_type}): hash mismatch - event has been tampered with`);
      }

      prevHash = e.event_hash as string;
    }

    return {
      valid: errors.length === 0,
      total_events: events.length,
      errors,
      checked_at: new Date().toISOString(),
    };
  }

  private rowToEvent(row: Record<string, unknown>): AuditEvent {
    return {
      id: row.id as string,
      sequence_num: row.sequence_num as number,
      prev_hash: row.prev_hash as string,
      event_hash: row.event_hash as string,
      event_type: row.event_type as AuditEventType,
      entity_id: row.entity_id as string,
      entity_type: row.entity_type as string,
      actor: row.actor as string,
      metadata: JSON.parse(row.metadata as string),
      timestamp: row.timestamp as string,
      session_id: (row.session_id as string) ?? undefined,
    };
  }
}

function redactSensitive(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (isSensitiveKey(k)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redactValue(v);
    }
  }
  return out;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value !== null && typeof value === 'object') {
    return redactSensitive(value as Record<string, unknown>);
  }
  return value;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return /(^|[^a-z])(password|secret|token|key|credential|authorization)([^a-z]|$)/.test(normalized);
}
