import { useState, useEffect, useCallback } from 'react';
import { api } from '../api.ts';
import { Card, Badge, Btn, SectionHeader, LoadingSpinner, ErrorBox, stateColor } from '../components/Card.tsx';

export default function AuditView() {
  const [events, setEvents] = useState<any[]>([]);
  const [verification, setVerification] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');

  const load = useCallback(async () => {
    try {
      const { events } = await api.getAuditEvents();
      setEvents(events);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function verify() {
    setVerifying(true);
    try {
      const { verification } = await api.verifyAudit();
      setVerification(verification);
      load();
    } catch (e: any) { setError(e.message); }
    finally { setVerifying(false); }
  }

  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorBox msg={error} />;

  const filtered = filter
    ? events.filter(e => e.event_type.includes(filter.toUpperCase()) || e.entity_id.includes(filter))
    : events;

  return (
    <div>
      <SectionHeader title="Audit Trail" sub="Tamper-evident hash-chained event log" />

      <div style={{ display: 'flex', gap: 12, marginBottom: 24, alignItems: 'center' }}>
        <Btn onClick={verify} disabled={verifying}>
          {verifying ? 'Verifying…' : '🔍 Verify Chain Integrity'}
        </Btn>
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter by event type or entity ID…"
          style={{ flex: 1, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6, padding: '8px 12px', color: 'var(--text)', fontSize: 13 }}
        />
      </div>

      {verification && (
        <Card style={{ marginBottom: 24, border: `1px solid ${verification.valid ? 'var(--green)' : 'var(--red)'}` }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 18 }}>{verification.valid ? '✅' : '❌'}</span>
            <strong style={{ color: verification.valid ? 'var(--green)' : 'var(--red)' }}>
              {verification.valid ? 'Chain integrity verified' : 'Chain integrity FAILED'}
            </strong>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{verification.total_events} events checked</span>
          </div>
          {verification.errors?.length > 0 && (
            <ul style={{ fontSize: 12, color: 'var(--red)', marginLeft: 20 }}>
              {verification.errors.map((e: string, i: number) => <li key={i}>{e}</li>)}
            </ul>
          )}
          <div style={{ fontSize: 11, color: 'var(--small)', marginTop: 8 }}>
            Checked at {new Date(verification.checked_at).toLocaleString()}
          </div>
        </Card>
      )}

      <Card>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 16 }}>
          Event Timeline ({filtered.length} events{filter ? ' filtered' : ''})
        </div>
        {filtered.length === 0 && <p style={{ color: 'var(--muted)' }}>No events.</p>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {[...filtered].reverse().map((e: any, i: number) => (
            <div key={e.id} style={{
              display: 'grid', gridTemplateColumns: '40px 180px 220px 1fr 120px',
              gap: 12, padding: '10px 0',
              borderBottom: '1px solid var(--border)',
              alignItems: 'start',
            }}>
              <span style={{ fontSize: 11, color: 'var(--small)', paddingTop: 2 }}>#{e.sequence_num}</span>
              <span style={{ fontSize: 11, color: 'var(--muted)' }}>{new Date(e.timestamp).toLocaleString()}</span>
              <Badge
                label={e.event_type}
                color={
                  e.event_type.includes('DENY') || e.event_type.includes('FAIL') || e.event_type.includes('REJECT') || e.event_type.includes('TAMPER') || e.event_type.includes('VIOLATION') ? 'red'
                    : e.event_type.includes('SUCCEEDED') || e.event_type.includes('VERIFIED') || e.event_type.includes('ALLOW') || e.event_type.includes('RESERVED') ? 'green'
                    : e.event_type.includes('PENDING') || e.event_type.includes('REQUEST') || e.event_type.includes('CREATED') ? 'blue'
                    : 'gray'
                }
              />
              <div>
                <span style={{ fontSize: 11, color: 'var(--small)' }}>{e.entity_id?.slice(0, 30)}</span>
                {Object.keys(e.metadata).length > 0 && (
                  <pre style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                    {JSON.stringify(e.metadata, null, 1).slice(0, 200)}
                  </pre>
                )}
              </div>
              <span style={{ fontSize: 10, color: 'var(--small)', fontFamily: 'monospace' }}>
                {e.event_hash?.slice(0, 12)}…
              </span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
