import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../../src/db/connection.js';
import { AuditService } from '../../src/audit/service.js';
import type Database from 'better-sqlite3';

describe('AuditService', () => {
  let db: Database.Database;
  let audit: AuditService;

  beforeEach(() => {
    db = createTestDb();
    audit = new AuditService(db);
  });

  it('records events with monotonically increasing sequence numbers', () => {
    audit.record('INTENT_CREATED', 'e1', 'intent', {}, 'system');
    audit.record('POLICY_EVALUATED', 'e1', 'intent', {}, 'system');
    audit.record('BUDGET_RESERVED', 'e1', 'intent', {}, 'system');

    const events = audit.getEvents();
    expect(events.map((e) => e.sequence_num)).toEqual([0, 1, 2]);
  });

  it('chains event hashes correctly', () => {
    audit.record('INTENT_CREATED', 'e1', 'intent', {}, 'system');
    audit.record('POLICY_EVALUATED', 'e1', 'intent', {}, 'system');

    const events = audit.getEvents();
    expect(events[1].prev_hash).toBe(events[0].event_hash);
  });

  it('verifies a clean chain successfully', () => {
    audit.record('INTENT_CREATED', 'e1', 'intent', { amount: 100 }, 'system');
    audit.record('BUDGET_RESERVED', 'e1', 'intent', { reserved: true }, 'system');
    const result = audit.verify();
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.total_events).toBe(2);
  });

  it('detects tampered event metadata', () => {
    audit.record('PAYMENT_STATE_CHANGED', 'txn_1', 'transaction', {
      from: 'RESERVED', to: 'SUCCEEDED', amount_minor: 1000,
    }, 'gateway');

    const events = audit.getEvents({ entity_id: 'txn_1' });
    // Tamper with the metadata
    db.prepare('UPDATE audit_events SET metadata = ? WHERE id = ?')
      .run(JSON.stringify({ from: 'RESERVED', to: 'SUCCEEDED', amount_minor: 9999999 }), events[0].id);

    const result = audit.verify();
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('tampered'))).toBe(true);
  });

  it('detects deleted event (chain break)', () => {
    audit.record('EVENT_A', 'e', 'test', {});
    audit.record('EVENT_B', 'e', 'test', {});
    audit.record('EVENT_C', 'e', 'test', {});

    const events = audit.getEvents();
    db.prepare('DELETE FROM audit_events WHERE id = ?').run(events[1].id);

    const result = audit.verify();
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('Gap') || e.includes('mismatch'))).toBe(true);
  });

  it('detects reordered events (prev_hash chain broken)', () => {
    audit.record('EVENT_A', 'e', 'test', {});
    audit.record('EVENT_B', 'e', 'test', {});
    audit.record('EVENT_C', 'e', 'test', {});

    const events = audit.getEvents();
    // Corrupt the middle event's prev_hash to simulate chain break
    db.prepare('UPDATE audit_events SET prev_hash = ? WHERE id = ?')
      .run('deadbeef'.repeat(8), events[1].id);

    const result = audit.verify();
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('mismatch') || e.includes('tampered'))).toBe(true);
  });

  it('redacts sensitive fields from metadata', () => {
    audit.record('POLICY_CREATED', 'pol_1', 'policy', {
      name: 'Test',
      client_secret: 'sk_live_supersecret',
      access_token: 'Bearer abc123',
    }, 'system');

    const events = audit.getEvents({ entity_id: 'pol_1' });
    expect(events[0].metadata.client_secret).toBe('[REDACTED]');
    expect(events[0].metadata.access_token).toBe('[REDACTED]');
    expect(events[0].metadata.name).toBe('Test');
  });

  it('empty chain verifies successfully', () => {
    const result = audit.verify();
    expect(result.valid).toBe(true);
    expect(result.total_events).toBe(0);
  });
});
