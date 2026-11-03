import { Routes, Route, NavLink } from 'react-router-dom';
import Overview from './views/Overview.tsx';
import Policies from './views/Policies.tsx';
import AgentActivity from './views/AgentActivity.tsx';
import Transactions from './views/Transactions.tsx';
import AuditView from './views/AuditView.tsx';
import SecurityLab from './views/SecurityLab.tsx';

const NAV = [
  { to: '/', label: '📊 Overview', end: true },
  { to: '/policies', label: '📋 Policies' },
  { to: '/agent', label: '🤖 Agent Activity' },
  { to: '/transactions', label: '💳 Transactions' },
  { to: '/audit', label: '🔍 Audit' },
  { to: '/lab', label: '⚔️ Security Lab' },
];

const s: Record<string, React.CSSProperties> = {
  layout: { display: 'flex', minHeight: '100vh' },
  sidebar: { width: 220, background: 'var(--surface)', borderRight: '1px solid var(--border)', padding: '24px 0', display: 'flex', flexDirection: 'column', gap: 4, flexShrink: 0 },
  brand: { padding: '0 20px 24px', borderBottom: '1px solid var(--border)', marginBottom: 8 },
  brandTitle: { fontSize: 18, fontWeight: 700, color: 'var(--accent)', letterSpacing: -0.5 },
  brandSub: { fontSize: 11, color: 'var(--muted)', marginTop: 4 },
  main: { flex: 1, overflow: 'auto', padding: 32 },
  navLink: { display: 'block', padding: '10px 20px', color: 'var(--muted)', textDecoration: 'none', borderRadius: 6, margin: '0 8px', fontSize: 13, transition: 'all 0.15s' },
};

export default function App() {
  return (
    <div style={s.layout}>
      <nav style={s.sidebar}>
        <div style={s.brand}>
          <div style={s.brandTitle}>🛡️ PayGuard</div>
          <div style={s.brandSub}>AI Payment Authorization</div>
        </div>
        {NAV.map(n => (
          <NavLink
            key={n.to} to={n.to} end={n.end}
            style={({ isActive }) => ({
              ...s.navLink,
              background: isActive ? 'rgba(99,102,241,0.15)' : 'transparent',
              color: isActive ? 'var(--accent-hover)' : 'var(--muted)',
            })}
          >
            {n.label}
          </NavLink>
        ))}
        <div style={{ flex: 1 }} />
        <div style={{ padding: '16px 20px', fontSize: 11, color: 'var(--small)', borderTop: '1px solid var(--border)' }}>
          PayPal AI Hackathon 2026
        </div>
      </nav>
      <main style={s.main}>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/policies" element={<Policies />} />
          <Route path="/agent" element={<AgentActivity />} />
          <Route path="/transactions" element={<Transactions />} />
          <Route path="/audit" element={<AuditView />} />
          <Route path="/lab" element={<SecurityLab />} />
        </Routes>
      </main>
    </div>
  );
}
