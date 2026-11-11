import { useState, useEffect, useCallback } from 'react';
import { api, errorMessage } from '../api.ts';
import { StatCard, Card, Badge, LoadingSpinner, ErrorBox, SectionHeader, ModeTag, fmt, stateColor, Btn } from '../components/Card.tsx';

export default function Overview() {
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.getStats>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const s = await api.getStats();
      setStats(s);
    } catch (error: unknown) {
      setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorBox msg={error} />;

  const p = stats?.active_policy;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <h2 style={{ fontSize: 22, fontWeight: 700 }}>Overview</h2>
        <ModeTag mode={stats?.provider_mode ?? 'simulated'} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 16, marginBottom: 32 }}>
        <StatCard label="Provider Mode" value={stats?.provider_mode?.toUpperCase() ?? '—'} color="var(--accent)" />
        <StatCard
          label="Committed Spend"
          value={fmt(stats?.committed_spend_minor ?? 0)}
          sub={`of ${p ? fmt(p.budget_limit_minor) : '—'} limit`}
          color="var(--text)"
        />
        <StatCard
          label="Remaining Budget"
          value={fmt(stats?.remaining_budget_minor ?? 0)}
          color={(stats?.remaining_budget_minor ?? 0) < 1000 ? 'var(--red)' : 'var(--green)'}
        />
        <StatCard
          label="Outstanding Reservations"
          value={fmt(stats?.outstanding_reservations_minor ?? 0)}
          color="var(--yellow)"
        />
        <StatCard label="Pending Approvals" value={stats?.pending_approvals ?? 0} color="var(--yellow)" />
        <StatCard label="Transactions" value={stats?.transaction_stats?.total ?? 0} />
      </div>

      {p && (
        <Card style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12, color: 'var(--accent)' }}>Active Policy</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 12 }}>
            {[
              ['Name', p.name],
              ['Agent ID', p.agent_id],
              ['Max Per-Transaction', fmt(p.max_amount_minor, p.currency)],
              ['Budget Period', p.budget_period],
              ['Budget Limit', fmt(p.budget_limit_minor, p.currency)],
              ['Currency', p.currency],
              ['Requires Approval', p.require_approval ? 'Yes' : 'No'],
              ['Expires', p.expires_at ? new Date(p.expires_at).toLocaleDateString() : 'Never'],
            ].map(([k, v]) => (
              <div key={k as string}>
                <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 2 }}>{k}</div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{v}</div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>Recent Audit Events</div>
        {(stats?.recent_audit_events ?? []).length === 0 ? (
          <p style={{ color: 'var(--muted)' }}>No events yet.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {(stats?.recent_audit_events ?? []).slice(0, 10).map(e => (
              <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                <span style={{ fontSize: 11, color: 'var(--small)', minWidth: 180 }}>{new Date(e.timestamp).toLocaleString()}</span>
                <Badge label={e.event_type} color={stateColor(e.event_type.includes('DENY') || e.event_type.includes('FAIL') || e.event_type.includes('REJECT') ? 'FAIL' : 'OK')} />
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{e.entity_id?.slice(0, 20)}</span>
                <span style={{ fontSize: 11, color: 'var(--small)' }}>by {e.actor}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
