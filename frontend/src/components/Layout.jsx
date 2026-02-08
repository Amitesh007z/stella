// ─── Stella Protocol — Sidebar Layout ─────────────────────────
import { NavLink, Outlet } from 'react-router-dom';

const NAV = [
  { to: '/',         icon: '◈', label: 'Dashboard' },
  { to: '/routes',   icon: '⇢', label: 'Route Finder' },
  { to: '/graph',    icon: '◎', label: 'Graph Explorer' },
  { to: '/anchors',  icon: '⚓', label: 'Anchors' },
  { to: '/assets',   icon: '◇', label: 'Assets' },
];

export default function Layout() {
  return (
    <div className="app-layout">
      {/* Background Orbs */}
      <div className="bg-orb bg-orb-1"></div>
      <div className="bg-orb bg-orb-2"></div>
      <div className="bg-orb bg-orb-3"></div>
      
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="logo">S</div>
          <div className="brand-text">
            <h1>STELLA</h1>
            <p>Routing Intelligence</p>
          </div>
        </div>
        <nav className="sidebar-nav">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/'}
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
            >
              <span className="nav-icon">{n.icon}</span>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div style={{ opacity: 0.6, fontSize: '11px' }}>
            Stellar Testnet • v0.1.0
          </div>
          <div style={{ 
            marginTop: '8px', 
            fontSize: '10px', 
            color: 'var(--text-muted)',
            fontWeight: 500 
          }}>
            Powered by Horizon API
          </div>
        </div>
      </aside>
      <main className="main-content">
        <Outlet />
      </main>
    </div>
  );
}
