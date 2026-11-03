import type { ReactNode, CSSProperties } from 'react';

export function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 10, padding: 20, ...style,
    }}>
      {children}
    </div>
  );
}

export function Badge({ label, color }: { label: string; color: 'green' | 'red' | 'yellow' | 'blue' | 'gray' }) {
  const colors = {
    green: '#22c55e22', red: '#ef444422', yellow: '#f59e0b22', blue: '#3b82f622', gray: '#94a3b822',
  };
  const text = {
    green: 'var(--green)', red: 'var(--red)', yellow: 'var(--yellow)', blue: 'var(--blue)', gray: 'var(--muted)',
  };
  return (
    <span style={{
      background: colors[color], color: text[color],
      padding: '2px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600,
    }}>
      {label}
    </span>
  );
}

export function StatCard({ label, value, sub, color }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <Card>
      <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: color ?? 'var(--text)' }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: 'var(--small)', marginTop: 4 }}>{sub}</div>}
    </Card>
  );
}

export function Btn({
  onClick, children, variant = 'primary', disabled = false, style,
}: {
  onClick?: () => void; children: ReactNode;
  variant?: 'primary' | 'danger' | 'ghost'; disabled?: boolean;
  style?: CSSProperties;
}) {
  const variants = {
    primary: { background: 'var(--accent)', color: '#fff', border: 'none' },
    danger: { background: 'var(--red)', color: '#fff', border: 'none' },
    ghost: { background: 'transparent', color: 'var(--muted)', border: '1px solid var(--border)' },
  };
  return (
    <button
      onClick={onClick} disabled={disabled}
      style={{
        ...variants[variant],
        padding: '8px 16px', borderRadius: 6, fontSize: 13, cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1, fontWeight: 600, transition: 'all 0.15s', ...style,
      }}
    >
      {children}
    </button>
  );
}

export function SectionHeader({ title, sub }: { title: string; sub?: string }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <h2 style={{ fontSize: 22, fontWeight: 700 }}>{title}</h2>
      {sub && <p style={{ color: 'var(--muted)', marginTop: 4 }}>{sub}</p>}
    </div>
  );
}

export function Table({ cols, rows }: { cols: string[]; rows: ReactNode[][] }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            {cols.map(c => (
              <th key={c} style={{ textAlign: 'left', padding: '8px 12px', color: 'var(--muted)', fontWeight: 600, borderBottom: '1px solid var(--border)' }}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
              {row.map((cell, j) => (
                <td key={j} style={{ padding: '10px 12px', verticalAlign: 'top' }}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--muted)' }}>No records found</div>
      )}
    </div>
  );
}

export function LoadingSpinner() {
  return <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>Loading…</div>;
}

export function ErrorBox({ msg }: { msg: string }) {
  return <div style={{ background: '#ef444415', border: '1px solid var(--red)', padding: 12, borderRadius: 6, color: 'var(--red)' }}>{msg}</div>;
}

export function ModeTag({ mode }: { mode: string }) {
  return (
    <span style={{
      background: mode === 'simulated' ? '#f59e0b22' : '#22c55e22',
      color: mode === 'simulated' ? 'var(--yellow)' : 'var(--green)',
      padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 700,
      textTransform: 'uppercase' as const, letterSpacing: 0.5,
    }}>
      {mode === 'simulated' ? '⚠ SIMULATED' : '✓ SANDBOX'}
    </span>
  );
}

export function fmt(minor: number, currency = 'USD') {
  const decimals = currency === 'JPY' ? 0 : 2;
  return `${currency} ${(minor / Math.pow(10, decimals)).toFixed(decimals)}`;
}

export function stateColor(state: string): 'green' | 'red' | 'yellow' | 'blue' | 'gray' {
  if (['SUCCEEDED', 'ALLOW'].includes(state)) return 'green';
  if (['FAILED', 'DENY', 'REPLAY'].includes(state)) return 'red';
  if (['PENDING_APPROVAL', 'RESERVED', 'PROPOSED', 'REQUIRE_APPROVAL'].includes(state)) return 'yellow';
  if (['PAYMENT_PENDING', 'AUTHORIZED', 'CAPTURE_PENDING'].includes(state)) return 'blue';
  if (['RECONCILIATION_REQUIRED', 'EXPIRED'].includes(state)) return 'yellow';
  return 'gray';
}
