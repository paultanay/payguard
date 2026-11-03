import { useState, useEffect, useCallback } from 'react';
import { api } from '../api.ts';
import { Card, Badge, Btn, SectionHeader, LoadingSpinner, ErrorBox, Table, fmt, stateColor, ModeTag } from '../components/Card.tsx';

export default function Transactions() {
  const [transactions, setTransactions] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionMsg, setActionMsg] = useState('');

  const load = useCallback(async () => {
    try {
      const { transactions } = await api.listTransactions();
      setTransactions(transactions);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

  async function capture(id: string) {
    setActionMsg('');
    try {
      const result = await api.captureTransaction(id);
      setActionMsg(`Transaction ${result.state}`);
      load();
    } catch (e: any) { setActionMsg('Error: ' + e.message); }
  }

  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorBox msg={error} />;

  return (
    <div>
      <SectionHeader title="Transactions" sub="Payment lifecycle and provider state" />
      {actionMsg && <div style={{ marginBottom: 16, padding: 12, background: '#3b82f615', borderRadius: 6, color: 'var(--blue)', fontSize: 13 }}>{actionMsg}</div>}
      <Card>
        <Table
          cols={['State', 'Amount', 'Payee', 'Provider', 'Mode', 'Intent', 'Created', 'Actions']}
          rows={transactions.map(t => [
            <Badge key="s" label={t.state} color={stateColor(t.state)} />,
            <span key="a">{fmt(t.amount_minor, t.currency)}</span>,
            <span key="p" style={{ fontSize: 12 }}>{t.payee_id}</span>,
            <span key="pr" style={{ fontSize: 11, color: 'var(--muted)' }}>{t.provider_id || '—'}</span>,
            <ModeTag key="m" mode={t.provider_mode} />,
            <span key="i" style={{ fontSize: 11, color: 'var(--small)' }}>{t.intent_id?.slice(0, 16)}…</span>,
            <span key="c" style={{ fontSize: 11, color: 'var(--small)' }}>{new Date(t.created_at).toLocaleString()}</span>,
            <span key="act">
              {t.state === 'PAYMENT_PENDING' && (
                <Btn onClick={() => capture(t.id)} style={{ fontSize: 12, padding: '4px 10px' }}>Capture</Btn>
              )}
              {t.state === 'RECONCILIATION_REQUIRED' && (
                <Badge label="Needs Reconciliation" color="yellow" />
              )}
            </span>,
          ])}
        />
      </Card>
    </div>
  );
}
