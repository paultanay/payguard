import { useState, useEffect, useCallback } from 'react';
import { api, errorMessage } from '../api.ts';
import { Card, Badge, Btn, SectionHeader, LoadingSpinner, ErrorBox, fmt, stateColor } from '../components/Card.tsx';

export default function AgentActivity() {
  const [policies, setPolicies] = useState<Awaited<ReturnType<typeof api.listPolicies>>['policies']>([]);
  const [intents, setIntents] = useState<Awaited<ReturnType<typeof api.listIntents>>['intents']>([]);
  const [approvals, setApprovals] = useState<Awaited<ReturnType<typeof api.listPendingApprovals>>['approvals']>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [aiRequest, setAiRequest] = useState('');
  const [selectedPolicy, setSelectedPolicy] = useState('');
  const [proposal, setProposal] = useState<Awaited<ReturnType<typeof api.generateProposal>>['proposal'] | null>(null);
  const [proposalLoading, setProposalLoading] = useState(false);
  const [semanticCheck, setSemanticCheck] = useState<Awaited<ReturnType<typeof api.semanticCheck>>['result'] | null>(null);
  const [approvalUrl, setApprovalUrl] = useState('');
  const [actionMsg, setActionMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const [{ policies }, { intents }, { approvals }] = await Promise.all([
        api.listPolicies(),
        api.listIntents(),
        api.listPendingApprovals(),
      ]);
      setPolicies(policies);
      setIntents(intents);
      setApprovals(approvals);
      if (policies.length > 0 && !selectedPolicy) setSelectedPolicy(policies[0].id);
    } catch (error: unknown) { setError(errorMessage(error)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function generateProposal() {
    if (!aiRequest.trim()) return;
    setProposalLoading(true); setProposal(null); setSemanticCheck(null); setApprovalUrl(''); setActionMsg('');
    try {
      const { proposal } = await api.generateProposal(aiRequest, selectedPolicy || undefined);
      setProposal(proposal);
    } catch (error: unknown) { setActionMsg(`Error: ${errorMessage(error)}`); }
    finally { setProposalLoading(false); }
  }

  async function createIntentFromProposal() {
    if (!proposal || !selectedPolicy) return;
    setActionMsg('');
    const policy = policies.find(p => p.id === selectedPolicy);
    if (!policy) return;
    try {
      const result = await api.createIntent({
        policy_id: selectedPolicy,
        agent_id: policy.agent_id,
        amount_minor: proposal.estimated_amount_minor,
        currency: proposal.currency,
        payee_id: proposal.suggested_payee_id || 'general_merchant',
        payee_name: proposal.suggested_payee_name,
        description: proposal.description,
      });

      // Semantic check
      const { result: check } = await api.semanticCheck(aiRequest, result.intent.id);
      setSemanticCheck(check);

      if (result.decision === 'ALLOW') {
        const exec = await api.executeIntent(result.intent.id);
        if (exec.approval_url) {
          setApprovalUrl(exec.approval_url);
          setActionMsg('Policy approved and budget reserved. Complete buyer approval in PayPal Sandbox, return here, then capture from Transactions.');
        } else if (exec.success && exec.transaction_id) {
          const cap = await api.captureTransaction(exec.transaction_id);
          setActionMsg(`✅ Payment ${cap.state} — Intent: ${result.intent.id}`);
        } else {
          setActionMsg(`Intent created — Decision: ${result.decision} — State: ${exec.state}`);
        }
      } else if (result.decision === 'REQUIRE_APPROVAL') {
        setActionMsg(`⏳ Approval required — Approval ID: ${result.approval_id}`);
      } else {
        setActionMsg(`🚫 DENIED — ${result.reason}`);
      }
      load();
    } catch (error: unknown) { setActionMsg(`Error: ${errorMessage(error)}`); }
  }

  async function approveApproval(id: string) {
    try { await api.approveApproval(id); load(); setActionMsg('✅ Approved'); } catch (error: unknown) { setActionMsg(`Error: ${errorMessage(error)}`); }
  }

  async function rejectApproval(id: string) {
    try { await api.rejectApproval(id); load(); setActionMsg('Rejected'); } catch (error: unknown) { setActionMsg(`Error: ${errorMessage(error)}`); }
  }

  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorBox msg={error} />;

  return (
    <div>
      <SectionHeader title="Agent Activity" sub="AI-assisted purchase proposals and tool invocations" />

      {/* AI Proposal Generator */}
      <Card style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>🤖 AI Purchase Proposal Generator</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>Natural Language Request</span>
            <input
              value={aiRequest}
              onChange={e => setAiRequest(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && generateProposal()}
              placeholder='e.g. "Buy a replacement mechanical keyboard under $30"'
              style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px', color: 'var(--text)', fontSize: 13 }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>Policy</span>
            <select
              value={selectedPolicy}
              onChange={e => setSelectedPolicy(e.target.value)}
              style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', color: 'var(--text)', fontSize: 13 }}
            >
              {policies.filter(p => p.status === 'active').map(p => (
                <option key={p.id} value={p.id}>{p.name} — agent: {p.agent_id}</option>
              ))}
            </select>
          </label>
          <Btn onClick={generateProposal} disabled={proposalLoading || !aiRequest.trim()}>
            {proposalLoading ? 'Generating…' : 'Generate Proposal'}
          </Btn>
        </div>

        {proposal && (
          <div style={{ marginTop: 20, padding: 16, background: 'var(--bg)', borderRadius: 8, border: '1px solid var(--border)' }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 12 }}>
              Proposal {proposal.ai_generated ? '🤖 AI-Generated' : '⚙ Deterministic Fallback'}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {[
                ['Item', proposal.item_name],
                ['Amount', fmt(proposal.estimated_amount_minor, proposal.currency)],
                ['Currency', proposal.currency],
                ['Payee', proposal.suggested_payee_name || proposal.suggested_payee_id || 'General Merchant'],
                ['Category', proposal.purchase_category || '—'],
                ['Confidence', `${((proposal.confidence ?? 0) * 100).toFixed(0)}%`],
              ].map(([k, v]) => (
                <div key={k as string}>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>{k}</div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{v}</div>
                </div>
              ))}
            </div>
            {proposal.rationale && <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10 }}>{proposal.rationale}</p>}
            <Btn onClick={createIntentFromProposal} style={{ marginTop: 12 }}>
              ▶ Create Intent &amp; Execute
            </Btn>
          </div>
        )}

        {semanticCheck && (
          <div style={{ marginTop: 12, padding: 12, background: semanticCheck.intent_matches ? '#22c55e15' : '#ef444415', borderRadius: 6, border: `1px solid ${semanticCheck.intent_matches ? 'var(--green)' : 'var(--red)'}` }}>
            <strong style={{ fontSize: 13 }}>Semantic Intent Check {semanticCheck.ai_generated ? '🤖' : '⚙'}</strong>
            <div style={{ fontSize: 12, marginTop: 4 }}>
              {semanticCheck.intent_matches ? '✅ Intent matches proposal' : `⚠ Mismatch: ${semanticCheck.mismatch_reason}`}
              {semanticCheck.flag_for_review && ' — Flagged for review'}
              {' — Confidence: '}{((semanticCheck.confidence ?? 0) * 100).toFixed(0)}%
            </div>
          </div>
        )}

        {actionMsg && (
          <div style={{ marginTop: 12, padding: 12, background: '#3b82f615', borderRadius: 6, color: 'var(--blue)', fontSize: 13 }}>
            {actionMsg}
            {approvalUrl && <div style={{ marginTop: 8 }}><a href={approvalUrl} target="_blank" rel="noreferrer">Continue to PayPal Sandbox approval ↗</a></div>}
          </div>
        )}
      </Card>

      {/* Pending Approvals */}
      {approvals.length > 0 && (
        <Card style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>⏳ Pending Approvals ({approvals.length})</div>
          {approvals.map(a => (
            <div key={a.id} style={{ padding: '12px 0', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>Approval: {a.id}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>Intent: {a.intent_id} · Expires: {new Date(a.expires_at).toLocaleString()}</div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <Btn onClick={() => approveApproval(a.id)}>✓ Approve</Btn>
                <Btn variant="danger" onClick={() => rejectApproval(a.id)}>✗ Reject</Btn>
              </div>
            </div>
          ))}
        </Card>
      )}

      {/* Recent Intents */}
      <Card>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>Recent Payment Intents</div>
        {intents.length === 0 ? (
          <p style={{ color: 'var(--muted)' }}>No intents yet. Generate a proposal above.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {intents.slice(0, 15).map(i => (
              <div key={i.id} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: 13 }}>
                <Badge label={i.state} color={stateColor(i.state)} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: 600 }}>{fmt(i.amount_minor, i.currency)}</span>
                  {' → '}{i.payee_id}
                  <span style={{ color: 'var(--muted)', marginLeft: 8, fontSize: 12 }}>{i.description?.slice(0, 60)}</span>
                </span>
                <span style={{ fontSize: 11, color: 'var(--small)', flexShrink: 0 }}>{new Date(i.created_at).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
