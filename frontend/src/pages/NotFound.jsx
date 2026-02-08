// ─── Stella Protocol — 404 Not Found Page ────────────────────
import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div style={{ textAlign: 'center', paddingTop: 80 }}>
      <div style={{ fontSize: 64, marginBottom: 12 }}>404</div>
      <h2 style={{ fontSize: 22, marginBottom: 8 }}>Page Not Found</h2>
      <p style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: 24 }}>
        The route you requested doesn't exist in Stella Protocol.
      </p>
      <Link to="/" className="btn btn-primary" style={{ textDecoration: 'none' }}>
        Back to Dashboard
      </Link>
    </div>
  );
}
