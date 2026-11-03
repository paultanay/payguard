/**
 * PayTrace — Portable Audit Evidence Bundle (.paytrace)
 *
 * A project-specific file format for exporting and verifying
 * payment audit evidence offline.
 *
 * IMPORTANT: This is NOT an established industry standard.
 * The .paytrace extension is project-specific to PayGuard.
 *
 * What a .paytrace bundle proves:
 *   - Structurally valid: JSON parses, required fields present, schema version matches
 *   - Integrity verified: all event hashes match recorded fields
 *   - Chain valid: prev_hash links are intact from genesis
 *   - Simulation-only: if provider_mode is 'simulated', transactions are NOT real
 *
 * What it does NOT prove:
 *   - That the events were created by a human
 *   - That the payment actually succeeded (unless provider_mode is 'sandbox' and independently verified with PayPal)
 *   - That the exporting party did not construct a fresh chain after tampering
 */

import type Database from 'better-sqlite3';
import { sha256, canonicalJson } from '../crypto/hash.js';

export const PAYTRACE_SCHEMA_VERSION = '1.0';

export interface PayTraceBundle {
  schema_version: string;
  exported_at: string;
  provider_mode: string;
  intent_id?: string;
  policy_snapshot?: Record<string, unknown>;
  events: PayTraceEvent[];
  integrity: PayTraceIntegrity;
}

export interface PayTraceEvent {
  sequence_num: number;
  event_type: string;
  entity_id: string;
  entity_type: string;
  actor: string;
  timestamp: string;
  metadata: Record<string, unknown>;
  prev_hash: string;
  event_hash: string;
}

export interface PayTraceIntegrity {
  total_events: number;
  genesis_hash: string;
  tip_hash: string;
  export_hash: string;  // SHA-256 of canonical events array
}

export interface VerifyBundleResult {
  structurally_valid: boolean;
  integrity_verified: boolean;
  chain_valid: boolean;
  simulation_only: boolean;
  errors: string[];
  total_events: number;
  schema_version: string;
}

const GENESIS_HASH = '0'.repeat(64);

export class PayTraceExporter {
  constructor(private db: Database.Database) {}

  export(intentId?: string, providerMode = 'simulated'): PayTraceBundle {
    let query = 'SELECT * FROM audit_events ORDER BY sequence_num ASC';
    const params: unknown[] = [];

    if (intentId) {
      query = 'SELECT * FROM audit_events WHERE entity_id = ? ORDER BY sequence_num ASC';
      params.push(intentId);
    }

    const rows = this.db.prepare(query).all(...params) as Record<string, unknown>[];

    const events: PayTraceEvent[] = rows.map(r => ({
      sequence_num: r.sequence_num as number,
      event_type: r.event_type as string,
      entity_id: r.entity_id as string,
      entity_type: r.entity_type as string,
      actor: r.actor as string,
      timestamp: r.timestamp as string,
      metadata: JSON.parse(r.metadata as string),
      prev_hash: r.prev_hash as string,
      event_hash: r.event_hash as string,
    }));

    const exportHash = sha256(canonicalJson({
      events: events.map(e => ({ ...e, metadata: e.metadata })),
    } as unknown as Record<string, unknown>));

    // Get policy if intentId provided
    let policySnapshot: Record<string, unknown> | undefined;
    if (intentId) {
      const intent = this.db.prepare('SELECT policy_id FROM payment_intents WHERE id = ?').get(intentId) as { policy_id: string } | undefined;
      if (intent) {
        const policy = this.db.prepare('SELECT id, name, version, max_amount_minor, budget_limit_minor, currency, status FROM policies WHERE id = ?').get(intent.policy_id) as Record<string, unknown> | undefined;
        policySnapshot = policy ?? undefined;
      }
    }

    return {
      schema_version: PAYTRACE_SCHEMA_VERSION,
      exported_at: new Date().toISOString(),
      provider_mode: providerMode,
      intent_id: intentId,
      policy_snapshot: policySnapshot,
      events,
      integrity: {
        total_events: events.length,
        genesis_hash: events[0]?.prev_hash ?? GENESIS_HASH,
        tip_hash: events[events.length - 1]?.event_hash ?? GENESIS_HASH,
        export_hash: exportHash,
      },
    };
  }

  /**
   * Verify a .paytrace bundle without access to the original database.
   * This is the portable offline verifier.
   */
  static verify(bundle: unknown): VerifyBundleResult {
    const errors: string[] = [];

    // --- Structural validation ---
    if (!bundle || typeof bundle !== 'object') {
      return { structurally_valid: false, integrity_verified: false, chain_valid: false, simulation_only: false, errors: ['Not a valid object'], total_events: 0, schema_version: 'unknown' };
    }

    const b = bundle as Record<string, unknown>;

    if (b.schema_version !== PAYTRACE_SCHEMA_VERSION) {
      errors.push(`Unknown schema_version: ${b.schema_version}`);
    }
    if (!b.exported_at || typeof b.exported_at !== 'string') {
      errors.push('Missing exported_at');
    }
    if (!Array.isArray(b.events)) {
      return { structurally_valid: false, integrity_verified: false, chain_valid: false, simulation_only: false, errors: ['Missing events array'], total_events: 0, schema_version: String(b.schema_version ?? 'unknown') };
    }

    const structurally_valid = errors.length === 0;
    const events = b.events as PayTraceEvent[];

    // --- Integrity verification ---
    let prevHash = GENESIS_HASH;
    let integrityErrors = 0;
    let chainErrors = 0;

    for (let i = 0; i < events.length; i++) {
      const e = events[i];

      // Recompute event hash
      const hashInput = canonicalJson({
        sequence_num: e.sequence_num,
        prev_hash: e.prev_hash,
        event_type: e.event_type,
        entity_id: e.entity_id,
        entity_type: e.entity_type,
        actor: e.actor,
        timestamp: e.timestamp,
        metadata: e.metadata,
      });
      const expectedHash = sha256(hashInput);

      if (expectedHash !== e.event_hash) {
        errors.push(`Event #${e.sequence_num} (${e.event_type}): hash mismatch — tampered`);
        integrityErrors++;
      }

      // Check chain linkage
      if (e.prev_hash !== prevHash) {
        errors.push(`Event #${e.sequence_num}: chain break — prev_hash mismatch`);
        chainErrors++;
      }

      prevHash = e.event_hash;
    }

    // Verify export hash
    const exportHash = sha256(canonicalJson({
      events: events.map(e => ({ ...e, metadata: e.metadata })),
    } as unknown as Record<string, unknown>));
    const integrity = b.integrity as PayTraceIntegrity;
    if (integrity?.export_hash && exportHash !== integrity.export_hash) {
      errors.push('Export hash mismatch — bundle export_hash invalid');
      integrityErrors++;
    }

    return {
      structurally_valid,
      integrity_verified: integrityErrors === 0,
      chain_valid: chainErrors === 0,
      simulation_only: b.provider_mode === 'simulated',
      errors,
      total_events: events.length,
      schema_version: String(b.schema_version ?? 'unknown'),
    };
  }
}
