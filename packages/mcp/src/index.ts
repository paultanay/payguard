/**
 * PayGuard MCP Server
 *
 * Implements the Model Context Protocol v2 (2026-07-28 spec) using
 * @modelcontextprotocol/server over stdio transport.
 *
 * All tools enforce the same authorization logic as the HTTP API.
 * No tool bypasses the policy engine.
 *
 * Trust model: This MCP server runs locally and trusts the local DB.
 * Do not expose it to untrusted networks without authentication.
 */

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Import backend modules
const { getDb } = await import('../../backend/src/db/connection.js');
const { PolicyEngine } = await import('../../backend/src/policy/engine.js');
const { IntentService } = await import('../../backend/src/intent/service.js');
const { AuditService } = await import('../../backend/src/audit/service.js');
const { PaymentSimulator } = await import('../../backend/src/provider/simulator.js');
const { PayPalAdapter } = await import('../../backend/src/provider/paypal.js');

// Initialize
const dataDir = path.resolve(__dirname, '../../../data');
fs.mkdirSync(dataDir, { recursive: true });
const db = getDb(path.join(dataDir, 'payguard.db'));

const useSimulator = !process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET;
const provider = useSimulator
  ? new PaymentSimulator()
  : new PayPalAdapter(process.env.PAYPAL_CLIENT_ID!, process.env.PAYPAL_CLIENT_SECRET!);

const policyEngine = new PolicyEngine(db);
const intentService = new IntentService(db, provider);
const auditService = new AuditService(db);

serveStdio(() => {
  const server = new McpServer({
    name: 'payguard',
    version: '0.1.0',
  });

  // ─── Tool: create_payment_proposal ──────────────────────────────────────────
  server.registerTool(
    'create_payment_proposal',
    {
      description: `Create a structured payment proposal and evaluate it against the active policy.
Returns the signed intent ID, policy decision (ALLOW/REQUIRE_APPROVAL/DENY), and reason.
The AI agent must not execute payments — only create proposals for human review.`,
      inputSchema: z.object({
        policy_id: z.string().describe('ID of the policy to evaluate against'),
        agent_id: z.string().describe('ID of the requesting agent'),
        amount_minor: z.number().int().positive().describe('Amount in minor units (e.g. USD cents: $19.99 = 1999)'),
        currency: z.string().length(3).describe('ISO 4217 currency code (e.g. USD)'),
        payee_id: z.string().describe('Merchant or payee identifier'),
        payee_name: z.string().optional().describe('Human-readable payee name'),
        description: z.string().describe('Description of what is being purchased'),
        idempotency_key: z.string().optional().describe('Optional idempotency key for safe retries'),
        ttl_seconds: z.number().int().positive().optional().describe('Intent TTL in seconds (default: 600)'),
      }),
    },
    async (args) => {
      try {
        const result = await intentService.createIntent({
          policy_id: args.policy_id,
          agent_id: args.agent_id,
          amount_minor: args.amount_minor,
          currency: args.currency,
          payee_id: args.payee_id,
          payee_name: args.payee_name,
          description: args.description,
          idempotency_key: args.idempotency_key,
          ttl_seconds: args.ttl_seconds,
        });

        auditService.record('MCP_TOOL_INVOKED', result.intent.id, 'intent', {
          tool: 'create_payment_proposal',
          decision: result.decision,
          agent_id: args.agent_id,
        }, 'mcp_client');

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              intent_id: result.intent.id,
              decision: result.decision,
              reason: result.reason,
              approval_id: result.approval_id,
              idempotent: result.idempotent,
              amount_minor: result.intent.amount_minor,
              currency: result.intent.currency,
              expires_at: result.intent.expires_at,
              provider_mode: provider.mode,
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  // ─── Tool: evaluate_payment_policy ──────────────────────────────────────────
  server.registerTool(
    'evaluate_payment_policy',
    {
      description: `Evaluate a payment request against a policy WITHOUT creating an intent or reserving budget.
Use this to check if a payment would be allowed before committing to it.`,
      inputSchema: z.object({
        policy_id: z.string().describe('Policy ID to evaluate'),
        agent_id: z.string().describe('Agent ID'),
        operation: z.string().default('purchase').describe('Operation type'),
        amount_minor: z.number().int().positive().describe('Amount in minor units'),
        currency: z.string().length(3).describe('Currency code'),
        payee_id: z.string().describe('Payee identifier'),
      }),
    },
    async (args) => {
      const result = policyEngine.evaluate({
        policy_id: args.policy_id,
        agent_id: args.agent_id,
        operation: args.operation,
        amount_minor: args.amount_minor,
        currency: args.currency,
        payee_id: args.payee_id,
      });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            decision: result.decision,
            reason: result.reason,
            remaining_budget_minor: result.remaining_budget_minor,
            period_key: result.period_key,
            policy_version: result.policy_version,
          }, null, 2),
        }],
      };
    },
  );

  // ─── Tool: get_payment_status ────────────────────────────────────────────────
  server.registerTool(
    'get_payment_status',
    {
      description: 'Get the current status of a payment intent and its associated transaction.',
      inputSchema: z.object({
        intent_id: z.string().describe('The payment intent ID (starts with int_)'),
      }),
    },
    async (args) => {
      const intent = intentService.getIntent(args.intent_id);
      if (!intent) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Intent not found' }) }],
          isError: true,
        };
      }

      const txn = intentService.getTransactionForIntent(args.intent_id);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            intent_id: intent.id,
            state: intent.state,
            amount_minor: intent.amount_minor,
            currency: intent.currency,
            payee_id: intent.payee_id,
            description: intent.description,
            created_at: intent.created_at,
            expires_at: intent.expires_at,
            transaction: txn ? {
              id: txn.id,
              state: txn.state,
              provider_mode: txn.provider_mode,
              provider_id: txn.provider_id,
              error_code: txn.error_code,
            } : null,
          }, null, 2),
        }],
      };
    },
  );

  // ─── Tool: request_payment_approval ─────────────────────────────────────────
  server.registerTool(
    'request_payment_approval',
    {
      description: `Request human approval for a payment that requires it.
Returns the approval ID and a message instructing the human to approve via the dashboard.
This tool does NOT execute the payment — it only signals that approval is needed.`,
      inputSchema: z.object({
        intent_id: z.string().describe('The intent ID that needs approval'),
      }),
    },
    async (args) => {
      const intent = intentService.getIntent(args.intent_id);
      if (!intent) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Intent not found' }) }],
          isError: true,
        };
      }

      if (intent.state !== 'PENDING_APPROVAL') {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              intent_id: args.intent_id,
              state: intent.state,
              message: `Intent is in state ${intent.state} — approval not required or already processed`,
            }),
          }],
        };
      }

      const { ApprovalService } = await import('../../backend/src/approval/service.js');
      const approvalService = new ApprovalService(db);
      const approval = approvalService.getPendingApprovalForIntent(args.intent_id);

      auditService.record('MCP_TOOL_INVOKED', args.intent_id, 'intent', {
        tool: 'request_payment_approval',
        approval_id: approval?.id,
      }, 'mcp_client');

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            intent_id: args.intent_id,
            approval_id: approval?.id,
            status: approval?.status ?? 'pending',
            message: 'Human approval required. Please visit the PayGuard dashboard to approve or reject this payment.',
            dashboard_url: `http://localhost:3001/#/approvals/${approval?.id}`,
            expires_at: approval?.expires_at,
          }, null, 2),
        }],
      };
    },
  );

  // ─── Tool: get_audit_evidence ────────────────────────────────────────────────
  server.registerTool(
    'get_audit_evidence',
    {
      description: `Retrieve audit trail events for a payment intent and verify chain integrity.
Returns the event timeline and integrity verification result.`,
      inputSchema: z.object({
        intent_id: z.string().describe('The payment intent ID to get audit evidence for'),
      }),
    },
    async (args) => {
      const events = auditService.getEvents({ entity_id: args.intent_id, limit: 50 });
      const verification = auditService.verify();

      auditService.record('MCP_TOOL_INVOKED', args.intent_id, 'intent', {
        tool: 'get_audit_evidence',
        event_count: events.length,
      }, 'mcp_client');

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            intent_id: args.intent_id,
            events: events.map((e) => ({
              sequence_num: e.sequence_num,
              event_type: e.event_type,
              actor: e.actor,
              timestamp: e.timestamp,
              metadata: e.metadata,
            })),
            chain_integrity: {
              valid: verification.valid,
              total_events: verification.total_events,
              errors: verification.errors,
            },
          }, null, 2),
        }],
      };
    },
  );

  return server;
});
