import { Routes, Route, NavLink } from 'react-router-dom';
import Overview from './views/Overview.tsx';
import Policies from './views/Policies.tsx';
import AgentActivity from './views/AgentActivity.tsx';
import Transactions from './views/Transactions.tsx';
import AuditView from './views/AuditView.tsx';
import SecurityLab from './views/SecurityLab.tsx';
import { Icon, type IconName } from './components/Icon.tsx';

const NAV: Array<{ to: string; label: string; icon: IconName; end?: boolean }> = [
  { to: '/', label: 'Overview', icon: 'overview', end: true },
  { to: '/policies', label: 'Policies', icon: 'policies' },
  { to: '/agent', label: 'Agent activity', icon: 'agent' },
  { to: '/transactions', label: 'Transactions', icon: 'transactions' },
  { to: '/audit', label: 'Audit trail', icon: 'audit' },
  { to: '/lab', label: 'Security lab', icon: 'lab' },
];

export default function App() {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#/" aria-label="PayGuard overview">
          <span className="brand-mark"><Icon name="shield" size={21} /></span>
          <span className="brand-copy">
            <strong>PayGuard</strong>
            <small>Payment authorization</small>
          </span>
        </a>

        <div className="nav-caption">WORKSPACE</div>
        <nav className="primary-nav" aria-label="Main navigation">
          {NAV.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
            >
              <Icon name={item.icon} size={18} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="environment-indicator"><span />Local environment</div>
          <span>PayGuard · Sandbox project</span>
        </div>
      </aside>

      <div className="main-column">
        <header className="topbar">
          <div className="topbar-context">PAYMENT CONTROLS <span>/</span> DEVELOPER CONSOLE</div>
          <div className="topbar-status"><span />Local workspace</div>
        </header>
        <main className="main-content">
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
    </div>
  );
}
