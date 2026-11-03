/**
 * Database schema DDL — single source of truth for table definitions.
 * Uses SQLite with WAL mode for concurrency-safe reads.
 * Budget enforcement uses UPDATE…WHERE with BEGIN IMMEDIATE for atomic reservations.
 */

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- ─── Policies ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS policies (
  id                TEXT PRIMARY KEY,
  version           INTEGER NOT NULL DEFAULT 1,
  owner_id          TEXT NOT NULL,
  agent_id          TEXT NOT NULL,
  name              TEXT NOT NULL,
  description       TEXT,
  allowed_operations TEXT NOT NULL DEFAULT '["purchase"]',  -- JSON array
  allowed_payees    TEXT NOT NULL DEFAULT '[]',              -- JSON array, empty = any
  max_amount_minor  INTEGER NOT NULL,  -- per-transaction limit in minor units
  currency          TEXT NOT NULL DEFAULT 'USD',
  budget_period     TEXT NOT NULL DEFAULT 'daily',           -- daily | weekly | monthly | total
  budget_limit_minor INTEGER NOT NULL,
  remaining_budget_minor INTEGER NOT NULL,                   -- updated atomically
  budget_period_key TEXT NOT NULL,                           -- e.g. "2026-11-02" for daily
  require_approval  INTEGER NOT NULL DEFAULT 0,              -- 0=false, 1=true
  status            TEXT NOT NULL DEFAULT 'active',          -- active | revoked | expired
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  expires_at        TEXT,
  metadata          TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_policies_agent ON policies(agent_id, status);

-- ─── Payment Intents ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_intents (
  id                TEXT PRIMARY KEY,
  policy_id         TEXT NOT NULL REFERENCES policies(id),
  agent_id          TEXT NOT NULL,
  nonce             TEXT NOT NULL UNIQUE,  -- replay prevention
  idempotency_key   TEXT NOT NULL UNIQUE,
  canonical_hash    TEXT NOT NULL,         -- SHA-256 of canonical fields
  signature         TEXT NOT NULL,         -- Ed25519 hex
  amount_minor      INTEGER NOT NULL,
  currency          TEXT NOT NULL,
  payee_id          TEXT NOT NULL,
  payee_name        TEXT,
  description       TEXT NOT NULL,
  operation         TEXT NOT NULL DEFAULT 'purchase',
  state             TEXT NOT NULL DEFAULT 'PROPOSED',
  policy_version    INTEGER NOT NULL,
  created_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  metadata          TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_intents_policy ON payment_intents(policy_id);
CREATE INDEX IF NOT EXISTS idx_intents_state ON payment_intents(state);
CREATE INDEX IF NOT EXISTS idx_intents_nonce ON payment_intents(nonce);

-- ─── Approvals ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS approvals (
  id               TEXT PRIMARY KEY,
  intent_id        TEXT NOT NULL REFERENCES payment_intents(id),
  policy_version   INTEGER NOT NULL,
  fields_hash      TEXT NOT NULL,   -- hash of amount+currency+payee+description
  status           TEXT NOT NULL DEFAULT 'pending',  -- pending | approved | rejected | expired
  approved_by      TEXT,
  reason           TEXT,
  created_at       TEXT NOT NULL,
  expires_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_approvals_intent ON approvals(intent_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

-- ─── Budget Reservations ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS budget_reservations (
  id               TEXT PRIMARY KEY,
  intent_id        TEXT NOT NULL,  -- FK intentionally omitted: budget reservation must be creatable before intent row exists in some test scenarios
  policy_id        TEXT NOT NULL REFERENCES policies(id),
  period_key       TEXT NOT NULL,
  amount_minor     INTEGER NOT NULL,
  currency         TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'reserved',  -- reserved | consumed | released | failed
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  transaction_id   TEXT
);

CREATE INDEX IF NOT EXISTS idx_reservations_policy ON budget_reservations(policy_id, period_key, status);
CREATE INDEX IF NOT EXISTS idx_reservations_intent ON budget_reservations(intent_id);

-- ─── Transactions ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id               TEXT PRIMARY KEY,
  intent_id        TEXT NOT NULL REFERENCES payment_intents(id),
  provider_id      TEXT,            -- PayPal order ID
  provider_mode    TEXT NOT NULL,   -- 'live' | 'sandbox' | 'simulated'
  state            TEXT NOT NULL DEFAULT 'PROPOSED',
  amount_minor     INTEGER NOT NULL,
  currency         TEXT NOT NULL,
  payee_id         TEXT NOT NULL,
  payee_name       TEXT,
  approval_id      TEXT REFERENCES approvals(id),
  reservation_id   TEXT REFERENCES budget_reservations(id),
  provider_response TEXT,           -- JSON, redacted of secrets
  error_code       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_txn_intent ON transactions(intent_id);
CREATE INDEX IF NOT EXISTS idx_txn_state ON transactions(state);
CREATE INDEX IF NOT EXISTS idx_txn_provider ON transactions(provider_id);

-- ─── Audit Events ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_events (
  id               TEXT PRIMARY KEY,
  sequence_num     INTEGER NOT NULL,
  prev_hash        TEXT NOT NULL,   -- SHA-256 of previous event (genesis='0000...0000')
  event_hash       TEXT NOT NULL,   -- SHA-256 of (sequence_num||prev_hash||event_type||entity_id||timestamp||metadata)
  event_type       TEXT NOT NULL,
  entity_id        TEXT NOT NULL,
  entity_type      TEXT NOT NULL,
  actor            TEXT NOT NULL DEFAULT 'system',
  metadata         TEXT NOT NULL DEFAULT '{}',
  timestamp        TEXT NOT NULL,
  session_id       TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_seq ON audit_events(sequence_num);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(entity_id, entity_type);
CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_events(event_type);

-- ─── Idempotency Records ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS idempotency_records (
  idem_key         TEXT PRIMARY KEY,
  intent_id        TEXT NOT NULL,
  response_hash    TEXT NOT NULL,
  created_at       TEXT NOT NULL
);

-- ─── Revocation Records ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS revocation_records (
  id              TEXT PRIMARY KEY,
  entity_id       TEXT NOT NULL,
  entity_type     TEXT NOT NULL,  -- 'policy' | 'intent' | 'approval'
  revoked_at      TEXT NOT NULL,
  reason          TEXT
);

CREATE INDEX IF NOT EXISTS idx_revocation_entity ON revocation_records(entity_id, entity_type);

-- ─── Schema version ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL,
  applied_at TEXT NOT NULL
);
`;
