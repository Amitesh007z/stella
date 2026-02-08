// ─── Stella Protocol — Admin Sidebar Layout ───────────────────
import { NavLink, Outlet } from 'react-router-dom';

const NAV = [
  { to: '/admin',          icon: '⊞', label: 'Dashboard' },
  { to: '/admin/routes',   icon: '⇢', label: 'Route Finder' },
  { to: '/admin/graph',    icon: '❖', label: 'Graph Explorer' },
  { to: '/admin/anchors',  icon: '⚓', label: 'Anchors' },
  { to: '/admin/assets',   icon: '◎', label: 'Assets' },
];

export default function AdminLayout() {
  return (
    <div className="app-layout">
      {/* Background Orbs */}
      <div className="bg-orb bg-orb-1"></div>
      <div className="bg-orb bg-orb-2"></div>
      <div className="bg-orb bg-orb-3"></div>
      
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="logo">
            <img 
              src="/logo.jpeg" 
              alt="Stella" 
              style={{ width: 32, height: 32, borderRadius: 6, objectFit: 'cover' }} 
            />
          </div>
          <div className="brand-text">
            <h1>STELLA</h1>
            <p>ROUTING INTELLIGENCE</p>
          </div>
        </div>
        <nav className="sidebar-nav">
          <div className="sidebar-nav-label">NAVIGATION</div>
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === '/admin'}
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
            >
              <span className="nav-icon">{n.icon}</span>
              {n.label}
            </NavLink>
          ))}
          <div style={{ height: '1px', background: 'rgba(255,255,255,0.04)', margin: '12px 12px' }} />
          <NavLink
            to="/"
            className="nav-link"
          >
            <span className="nav-icon">←</span>
            Back to Home
          </NavLink>
        </nav>
        <div className="sidebar-footer">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--success)', display: 'inline-block' }} />
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Stellar Testnet · v0.1.0</span>
          </div>
        </div>
      </aside>
      <main className="main-content">
        <div className="admin-topbar">
          <div className="network-badge">
            <span className="network-dot" />
            <span className="network-icon">⊕</span>
            Stellar Testnet
          </div>
        </div>
        <Outlet />
      </main>
    </div>
  );
}
