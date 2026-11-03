import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../../src/db/connection.js';
import { AuditService } from '../../src/audit/service.js';
import { PayTraceExporter } from '../../src/audit/paytrace.js';
import type Database from 'better-sqlite3';

describe('PayTrace portable audit bundle', () => {
  let db: Database.Database;
  let audit: AuditService;

  beforeEach(() => {
    db = createTestDb();
    audit = new AuditService(db);
  });

  it('exports a valid bundle', () => {
    audit.record('INTENT_CREATED', 'int_1', 'intent', { amount_minor: 1000 });
    audit.record('BUDGET_RESERVED', 'int_1', 'intent', { amount_minor: 1000 });
    audit.record('PAYMENT_STATE_CHANGED', 'int_1', 'intent', { to: 'SUCCEEDED' });

    const exporter = new PayTraceExporter(db);
    const bundle = exporter.export('int_1', 'simulated');

    expect(bundle.schema_version).toBe('1.0');
    expect(bundle.events.length).toBe(3);
    expect(bundle.provider_mode).toBe('simulated');
    expect(bundle.integrity.total_events).toBe(3);
    expect(bundle.integrity.export_hash).toHaveLength(64);
  });

  it('verifies a valid bundle', () => {
    audit.record('INTENT_CREATED', 'int_1', 'intent', { amount_minor: 500 });
    audit.record('SUCCEEDED', 'int_1', 'intent', {});

    const exporter = new PayTraceExporter(db);
    const bundle = exporter.export();
    const result = PayTraceExporter.verify(bundle);

    expect(result.structurally_valid).toBe(true);
    expect(result.integrity_verified).toBe(true);
    expect(result.chain_valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('detects tampered event in exported bundle', () => {
    audit.record('PAYMENT_STATE_CHANGED', 'txn_1', 'transaction', { amount_minor: 1000, to: 'SUCCEEDED' });

    const exporter = new PayTraceExporter(db);
    const bundle = exporter.export();

    // Tamper the exported bundle
    bundle.events[0].metadata = { amount_minor: 999999, to: 'SUCCEEDED' };

    const result = PayTraceExporter.verify(bundle);
    expect(result.integrity_verified).toBe(false);
    expect(result.errors.some(e => e.includes('tampered'))).toBe(true);
  });

  it('detects modified export_hash in bundle', () => {
    audit.record('INTENT_CREATED', 'int_1', 'intent', { amount_minor: 100 });

    const exporter = new PayTraceExporter(db);
    const bundle = exporter.export();

    // Tamper the export hash
    bundle.integrity.export_hash = 'a'.repeat(64);

    const result = PayTraceExporter.verify(bundle);
    expect(result.integrity_verified).toBe(false);
    expect(result.errors.some(e => e.includes('export_hash') || e.includes('export hash'))).toBe(true);
  });

  it('flags simulation-only mode', () => {
    audit.record('INTENT_CREATED', 'int_1', 'intent', {});
    const exporter = new PayTraceExporter(db);
    const bundle = exporter.export(undefined, 'simulated');
    const result = PayTraceExporter.verify(bundle);
    expect(result.simulation_only).toBe(true);
  });

  it('returns structurally invalid for garbage input', () => {
    const result = PayTraceExporter.verify('not a bundle');
    expect(result.structurally_valid).toBe(false);
  });

  it('verifies empty bundle (no events)', () => {
    const exporter = new PayTraceExporter(db);
    const bundle = exporter.export();
    const result = PayTraceExporter.verify(bundle);
    expect(result.structurally_valid).toBe(true);
    expect(result.integrity_verified).toBe(true);
    expect(result.total_events).toBe(0);
  });
});
