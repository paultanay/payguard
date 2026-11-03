import { z } from 'zod';

// Supported budget periods
export const BudgetPeriodSchema = z.enum(['daily', 'weekly', 'monthly', 'total']);
export type BudgetPeriod = z.infer<typeof BudgetPeriodSchema>;

// Supported operations
export const OperationSchema = z.enum(['purchase', 'refund', 'authorize']);
export type Operation = z.infer<typeof OperationSchema>;

export const PolicyStatusSchema = z.enum(['active', 'revoked', 'expired']);
export type PolicyStatus = z.infer<typeof PolicyStatusSchema>;

/** The validated policy model. All amounts are in integer minor units. */
export const PolicySchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  owner_id: z.string().min(1),
  agent_id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  allowed_operations: z.array(OperationSchema).min(1),
  /** Empty array = any payee allowed */
  allowed_payees: z.array(z.string()),
  /** Per-transaction limit in minor units (e.g. USD: cents) */
  max_amount_minor: z.number().int().positive(),
  currency: z.string().length(3),
  budget_period: BudgetPeriodSchema,
  /** Total spend budget for the period */
  budget_limit_minor: z.number().int().positive(),
  /** Remaining budget for the current period — updated atomically */
  remaining_budget_minor: z.number().int().min(0),
  budget_period_key: z.string(),
  require_approval: z.boolean(),
  status: PolicyStatusSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  expires_at: z.string().datetime().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type Policy = z.infer<typeof PolicySchema>;

export const CreatePolicyInputSchema = z.object({
  owner_id: z.string().min(1),
  agent_id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  allowed_operations: z.array(OperationSchema).min(1).default(['purchase']),
  allowed_payees: z.array(z.string()).default([]),
  max_amount_minor: z.number().int().positive(),
  currency: z.string().length(3).default('USD'),
  budget_period: BudgetPeriodSchema.default('daily'),
  budget_limit_minor: z.number().int().positive(),
  require_approval: z.boolean().default(false),
  expires_at: z.string().datetime().optional(),
});

export type CreatePolicyInput = z.infer<typeof CreatePolicyInputSchema>;

/** Compute the period key for "now" given a budget period. */
export function computePeriodKey(period: BudgetPeriod, now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const week = getISOWeek(now);

  switch (period) {
    case 'daily':
      return `${y}-${m}-${d}`;
    case 'weekly':
      return `${y}-W${String(week).padStart(2, '0')}`;
    case 'monthly':
      return `${y}-${m}`;
    case 'total':
      return 'total';
  }
}

function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}
