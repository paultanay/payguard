import { useState, useEffect, useCallback } from 'react';
import { api, errorMessage } from '../api.ts';
import { Card, Badge, Btn, SectionHeader, LoadingSpinner, ErrorBox, fmt, stateColor } from '../components/Card.tsx';

export default function Policies() {
  type TextField = 'owner_id' | 'agent_id' | 'name' | 'max_amount_minor' | 'budget_limit_minor' | 'currency' | 'allowed_payees';
  const fields: Array<{ key: TextField; label: string; type: 'text' | 'number' }> = [
    { key: 'owner_id', label: 'Owner ID', type: 'text' },
    { key: 'agent_id', label: 'Agent ID', type: 'text' },
    { key: 'name', label: 'Policy Name', type: 'text' },
    { key: 'max_amount_minor', label: 'Max Per-Transaction (minor units)', type: 'number' },
    { key: 'budget_limit_minor', label: 'Budget Limit (minor units)', type: 'number' },
    { key: 'currency', label: 'Currency', type: 'text' },
    { key: 'allowed_payees', label: 'Allowed Payees (comma-separated, empty allows any)', type: 'text' },
  ];
  const [policies, setPolicies] = useState<Awaited<ReturnType<typeof api.listPolicies>>['policies']>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<{
    owner_id: string; agent_id: string; name: string; max_amount_minor: number;
    budget_limit_minor: number; budget_period: 'daily' | 'weekly' | 'monthly' | 'total';
    currency: string; require_approval: boolean; allowed_payees: string;
  }>({
    owner_id: 'user1', agent_id: 'ai_agent_1', name: 'Default Policy',
    max_amount_minor: 5000, budget_limit_minor: 50000,
    budget_period: 'daily', currency: 'USD', require_approval: false,
    allowed_payees: '',
  });
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const { policies } = await api.listPolicies();
      setPolicies(policies);
    } catch (error: unknown) { setError(errorMessage(error)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function createPolicy() {
    setCreating(true); setMsg('');
    try {
      await api.createPolicy({
        ...form,
        max_amount_minor: Number(form.max_amount_minor),
        budget_limit_minor: Number(form.budget_limit_minor),
        allowed_payees: form.allowed_payees ? form.allowed_payees.split(',').map(s => s.trim()).filter(Boolean) : [],
      });
      setMsg('Policy created!');
      setShowCreate(false);
      load();
    } catch (error: unknown) { setMsg(`Error: ${errorMessage(error)}`); }
    finally { setCreating(false); }
  }

  async function revokePolicy(id: string) {
    if (!confirm('Revoke this policy?')) return;
    try { await api.revokePolicy(id); load(); } catch (error: unknown) { alert(errorMessage(error)); }
  }

  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorBox msg={error} />;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <SectionHeader title="Policies" sub="Configure spending policies for AI agents" />
        <Btn onClick={() => setShowCreate(!showCreate)}>{showCreate ? 'Cancel' : '+ Create Policy'}</Btn>
      </div>

      {msg && <div style={{ marginBottom: 16, padding: 12, background: '#22c55e22', borderRadius: 6, color: 'var(--green)' }}>{msg}</div>}

      {showCreate && (
        <Card style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>New Policy</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {fields.map(({ key, label, type }) => (
              <label key={key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>{label}</span>
                <input
                  type={type as string}
                  value={form[key]}
                  onChange={e => setForm(f => ({ ...f, [key]: type === 'number' ? Number(e.target.value) : e.target.value }))}
                  style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', color: 'var(--text)', fontSize: 13 }}
                />
              </label>
            ))}
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={form.require_approval} onChange={e => setForm(f => ({ ...f, require_approval: e.target.checked }))} />
              <span style={{ fontSize: 13 }}>Require human approval for every transaction</span>
            </label>
          </div>
          <Btn onClick={createPolicy} disabled={creating} style={{ marginTop: 16 }}>
            {creating ? 'Creating…' : 'Create Policy'}
          </Btn>
        </Card>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {policies.length === 0 && <Card><p style={{ color: 'var(--muted)' }}>No policies yet. Create one to get started.</p></Card>}
        {policies.map(p => (
          <Card key={p.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
                  <span style={{ fontWeight: 700, fontSize: 15 }}>{p.name}</span>
                  <Badge label={p.status} color={stateColor(p.status === 'active' ? 'ALLOW' : 'DENY')} />
                  <span style={{ fontSize: 11, color: 'var(--small)' }}>v{p.version}</span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
                  Agent: <strong>{p.agent_id}</strong> · Owner: {p.owner_id}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: 16 }}>
                  {[
                    ['Max/Transaction', fmt(p.max_amount_minor, p.currency)],
                    ['Budget Limit', fmt(p.budget_limit_minor, p.currency)],
                    ['Remaining', fmt(p.remaining_budget_minor, p.currency)],
                    ['Period', p.budget_period],
                    ['Approval Required', p.require_approval ? 'Yes' : 'No'],
                    ['Payees', p.allowed_payees?.length ? p.allowed_payees.join(', ') : 'Any'],
                  ].map(([k, v]) => (
                    <div key={k as string}>
                      <div style={{ fontSize: 11, color: 'var(--small)' }}>{k}</div>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{v}</div>
                    </div>
                  ))}
                </div>
              </div>
              {p.status === 'active' && (
                <Btn variant="danger" onClick={() => revokePolicy(p.id)}>Revoke</Btn>
              )}
            </div>
            <div style={{ fontSize: 11, color: 'var(--small)', marginTop: 12 }}>
              ID: {p.id} · Created: {new Date(p.created_at).toLocaleString()}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
