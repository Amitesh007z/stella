// ─── Stella Protocol — Route Verification Page ─────────────────
// Allows users to verify route commitments against the on-chain registry
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { verifyRouteCommitment, getRouteCommitment } from '../api';

export default function RouteVerification() {
  const [routeHash, setRouteHash] = useState('');
  const [commitment, setCommitment] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [verifyMode, setVerifyMode] = useState('lookup'); // 'lookup' | 'verify'
  
  // For full verification mode
  const [rulesHash, setRulesHash] = useState('');
  const [solverHash, setSolverHash] = useState('');
  const [verificationResult, setVerificationResult] = useState(null);

  const handleLookup = async (e) => {
    e.preventDefault();
    if (!routeHash.trim()) return;
    
    setLoading(true);
    setError(null);
    setCommitment(null);
    
    try {
      const result = await getRouteCommitment(routeHash.trim());
      setCommitment(result);
    } catch (err) {
      setError(err.message || 'Commitment not found');
    } finally {
      setLoading(false);
    }
  };

  const handleVerify = async (e) => {
    e.preventDefault();
    if (!routeHash.trim() || !rulesHash.trim() || !solverHash.trim()) return;
    
    setLoading(true);
    setError(null);
    setVerificationResult(null);
    
    try {
      const result = await verifyRouteCommitment({
        routeHash: routeHash.trim(),
        rulesHash: rulesHash.trim(),
        solverHash: solverHash.trim(),
      });
      setVerificationResult(result);
    } catch (err) {
      setError(err.message || 'Verification failed');
    } finally {
      setLoading(false);
    }
  };

  const formatTimestamp = (ts) => {
    if (!ts) return 'N/A';
    return new Date(ts * 1000).toLocaleString();
  };

  const truncateHash = (hash) => {
    if (!hash || hash.length < 16) return hash;
    return `${hash.slice(0, 8)}...${hash.slice(-8)}`;
  };

  return (
    <div className="verify-page">
      <style>{`
        .verify-page {
          min-height: 100vh;
          background: linear-gradient(135deg, #0a0a0f 0%, #12121a 50%, #0f0f14 100%);
          color: #e4e4e7;
          font-family: 'Inter', -apple-system, sans-serif;
        }

        .verify-header {
          padding: 1.5rem 2rem;
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-bottom: 1px solid rgba(212, 85, 58, 0.15);
        }

        .verify-logo {
          display: flex;
          align-items: center;
          gap: 0.75rem;
        }

        .verify-logo img {
          width: 40px;
          height: 40px;
          border-radius: 10px;
        }

        .verify-logo-text {
          font-size: 1.25rem;
          font-weight: 700;
          color: #d4553a;
        }

        .verify-nav {
          display: flex;
          gap: 1.5rem;
        }

        .verify-nav a {
          color: #9ca3af;
          text-decoration: none;
          font-size: 0.9rem;
          transition: color 0.2s;
        }

        .verify-nav a:hover {
          color: #d4553a;
        }

        .verify-main {
          max-width: 800px;
          margin: 0 auto;
          padding: 3rem 2rem;
        }

        .verify-title {
          font-size: 2.5rem;
          font-weight: 700;
          margin-bottom: 0.5rem;
          background: linear-gradient(135deg, #d4553a 0%, #e07a62 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }

        .verify-subtitle {
          color: #9ca3af;
          font-size: 1.1rem;
          margin-bottom: 2rem;
        }

        .info-box {
          background: rgba(212, 85, 58, 0.08);
          border: 1px solid rgba(212, 85, 58, 0.2);
          border-radius: 12px;
          padding: 1.25rem;
          margin-bottom: 2rem;
        }

        .info-box h3 {
          color: #d4553a;
          font-size: 1rem;
          margin-bottom: 0.75rem;
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }

        .info-box p {
          color: #9ca3af;
          font-size: 0.9rem;
          line-height: 1.6;
          margin: 0;
        }

        .mode-toggle {
          display: flex;
          gap: 0.5rem;
          margin-bottom: 1.5rem;
          background: rgba(255, 255, 255, 0.03);
          padding: 0.25rem;
          border-radius: 10px;
          border: 1px solid rgba(255, 255, 255, 0.06);
        }

        .mode-btn {
          flex: 1;
          padding: 0.75rem 1rem;
          border: none;
          background: transparent;
          color: #9ca3af;
          font-size: 0.9rem;
          font-weight: 500;
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.2s;
        }

        .mode-btn.active {
          background: rgba(212, 85, 58, 0.15);
          color: #d4553a;
        }

        .mode-btn:hover:not(.active) {
          background: rgba(255, 255, 255, 0.05);
        }

        .verify-form {
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 16px;
          padding: 1.5rem;
        }

        .form-group {
          margin-bottom: 1rem;
        }

        .form-group label {
          display: block;
          color: #9ca3af;
          font-size: 0.85rem;
          margin-bottom: 0.5rem;
          font-weight: 500;
        }

        .form-group input {
          width: 100%;
          padding: 0.9rem 1rem;
          background: rgba(0, 0, 0, 0.3);
          border: 1px solid rgba(255, 255, 255, 0.1);
          border-radius: 10px;
          color: #e4e4e7;
          font-size: 0.9rem;
          font-family: 'JetBrains Mono', monospace;
          outline: none;
          transition: border-color 0.2s;
        }

        .form-group input:focus {
          border-color: #d4553a;
        }

        .form-group input::placeholder {
          color: #4b5563;
        }

        .submit-btn {
          width: 100%;
          padding: 1rem;
          background: linear-gradient(135deg, #d4553a 0%, #c44a32 100%);
          border: none;
          border-radius: 10px;
          color: white;
          font-size: 1rem;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s;
          margin-top: 0.5rem;
        }

        .submit-btn:hover:not(:disabled) {
          transform: translateY(-1px);
          box-shadow: 0 4px 20px rgba(212, 85, 58, 0.4);
        }

        .submit-btn:disabled {
          opacity: 0.6;
          cursor: not-allowed;
        }

        .error-msg {
          background: rgba(239, 68, 68, 0.1);
          border: 1px solid rgba(239, 68, 68, 0.3);
          color: #f87171;
          padding: 1rem;
          border-radius: 10px;
          margin-top: 1rem;
          font-size: 0.9rem;
        }

        .result-card {
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 16px;
          margin-top: 1.5rem;
          overflow: hidden;
        }

        .result-header {
          padding: 1rem 1.5rem;
          background: rgba(212, 85, 58, 0.1);
          border-bottom: 1px solid rgba(255, 255, 255, 0.06);
          display: flex;
          align-items: center;
          gap: 0.75rem;
        }

        .result-header.verified {
          background: rgba(34, 197, 94, 0.1);
        }

        .result-header.not-verified {
          background: rgba(239, 68, 68, 0.1);
        }

        .status-icon {
          width: 24px;
          height: 24px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 0.9rem;
        }

        .status-icon.found { background: rgba(212, 85, 58, 0.2); }
        .status-icon.verified { background: rgba(34, 197, 94, 0.2); }
        .status-icon.not-verified { background: rgba(239, 68, 68, 0.2); }

        .result-title {
          font-weight: 600;
          font-size: 1rem;
        }

        .result-body {
          padding: 1.5rem;
        }

        .data-row {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          padding: 0.75rem 0;
          border-bottom: 1px solid rgba(255, 255, 255, 0.04);
        }

        .data-row:last-child {
          border-bottom: none;
        }

        .data-label {
          color: #9ca3af;
          font-size: 0.85rem;
          font-weight: 500;
        }

        .data-value {
          color: #e4e4e7;
          font-size: 0.85rem;
          font-family: 'JetBrains Mono', monospace;
          text-align: right;
          word-break: break-all;
          max-width: 60%;
        }

        .data-value.hash {
          color: #d4553a;
        }

        .data-value.timestamp {
          color: #60a5fa;
        }

        .data-value.address {
          color: #a78bfa;
        }

        .how-it-works {
          margin-top: 3rem;
          padding: 2rem;
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 16px;
        }

        .how-it-works h3 {
          color: #d4553a;
          font-size: 1.25rem;
          margin-bottom: 1.5rem;
        }

        .step-list {
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }

        .step {
          display: flex;
          gap: 1rem;
          align-items: flex-start;
        }

        .step-num {
          width: 28px;
          height: 28px;
          background: rgba(212, 85, 58, 0.15);
          color: #d4553a;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 0.8rem;
          font-weight: 600;
          flex-shrink: 0;
        }

        .step-content h4 {
          color: #e4e4e7;
          font-size: 0.95rem;
          margin-bottom: 0.25rem;
        }

        .step-content p {
          color: #6b7280;
          font-size: 0.85rem;
          line-height: 1.5;
          margin: 0;
        }

        .contract-info {
          margin-top: 2rem;
          padding: 1.25rem;
          background: rgba(212, 85, 58, 0.05);
          border: 1px dashed rgba(212, 85, 58, 0.3);
          border-radius: 12px;
        }

        .contract-info h4 {
          color: #d4553a;
          font-size: 0.9rem;
          margin-bottom: 0.75rem;
        }

        .contract-info code {
          display: block;
          background: rgba(0, 0, 0, 0.3);
          padding: 0.75rem;
          border-radius: 8px;
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.8rem;
          color: #9ca3af;
          word-break: break-all;
        }

        @media (max-width: 640px) {
          .verify-main {
            padding: 2rem 1rem;
          }
          .verify-title {
            font-size: 1.75rem;
          }
          .data-row {
            flex-direction: column;
            gap: 0.25rem;
          }
          .data-value {
            max-width: 100%;
            text-align: left;
          }
        }
      `}</style>

      <header className="verify-header">
        <Link to="/" className="verify-logo">
          <img src="/Untitled.jpeg" alt="Stella" />
          <span className="verify-logo-text">Stella</span>
        </Link>
        <nav className="verify-nav">
          <Link to="/">Swap</Link>
          <Link to="/admin">Admin</Link>
          <a href="https://github.com/Amitesh007z/stella" target="_blank" rel="noopener">GitHub</a>
        </nav>
      </header>

      <main className="verify-main">
        <h1 className="verify-title">Route Integrity Verification</h1>
        <p className="verify-subtitle">
          Verify that routes were selected using publicly committed rules
        </p>

        <div className="info-box">
          <h3>🔐 On-Chain Transparency</h3>
          <p>
            Every route computed by Stella Protocol is cryptographically committed to the 
            RouteIntegrityRegistry smart contract on Stellar. This allows anyone to verify 
            that routing decisions were made using published, neutral rules — without any 
            favoritism toward specific anchors or liquidity providers.
          </p>
        </div>

        <div className="mode-toggle">
          <button 
            className={`mode-btn ${verifyMode === 'lookup' ? 'active' : ''}`}
            onClick={() => setVerifyMode('lookup')}
          >
            🔍 Lookup Commitment
          </button>
          <button 
            className={`mode-btn ${verifyMode === 'verify' ? 'active' : ''}`}
            onClick={() => setVerifyMode('verify')}
          >
            ✓ Full Verification
          </button>
        </div>

        {verifyMode === 'lookup' ? (
          <form className="verify-form" onSubmit={handleLookup}>
            <div className="form-group">
              <label>Route Hash (SHA-256)</label>
              <input
                type="text"
                value={routeHash}
                onChange={(e) => setRouteHash(e.target.value)}
                placeholder="Enter 64-character hex hash..."
                maxLength={64}
              />
            </div>
            <button type="submit" className="submit-btn" disabled={loading || !routeHash.trim()}>
              {loading ? 'Looking up...' : 'Lookup Commitment'}
            </button>
          </form>
        ) : (
          <form className="verify-form" onSubmit={handleVerify}>
            <div className="form-group">
              <label>Route Hash</label>
              <input
                type="text"
                value={routeHash}
                onChange={(e) => setRouteHash(e.target.value)}
                placeholder="SHA-256 hash of route manifest..."
                maxLength={64}
              />
            </div>
            <div className="form-group">
              <label>Expected Rules Hash</label>
              <input
                type="text"
                value={rulesHash}
                onChange={(e) => setRulesHash(e.target.value)}
                placeholder="SHA-256 hash of routing rules config..."
                maxLength={64}
              />
            </div>
            <div className="form-group">
              <label>Expected Solver Version Hash</label>
              <input
                type="text"
                value={solverHash}
                onChange={(e) => setSolverHash(e.target.value)}
                placeholder="SHA-256 hash of solver commit/version..."
                maxLength={64}
              />
            </div>
            <button 
              type="submit" 
              className="submit-btn" 
              disabled={loading || !routeHash.trim() || !rulesHash.trim() || !solverHash.trim()}
            >
              {loading ? 'Verifying...' : 'Verify Commitment'}
            </button>
          </form>
        )}

        {error && <div className="error-msg">❌ {error}</div>}

        {commitment && (
          <div className="result-card">
            <div className="result-header">
              <span className="status-icon found">📋</span>
              <span className="result-title">Commitment Found</span>
            </div>
            <div className="result-body">
              <div className="data-row">
                <span className="data-label">Route Hash</span>
                <span className="data-value hash">{commitment.routeHash}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Rules Hash</span>
                <span className="data-value hash">{commitment.rulesHash}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Solver Version Hash</span>
                <span className="data-value hash">{commitment.solverVersionHash}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Committer</span>
                <span className="data-value address">{truncateHash(commitment.committer)}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Committed At</span>
                <span className="data-value timestamp">{formatTimestamp(commitment.timestamp)}</span>
              </div>
              <div className="data-row">
                <span className="data-label">Expires</span>
                <span className="data-value timestamp">
                  {commitment.expiry ? formatTimestamp(commitment.expiry) : 'Never'}
                </span>
              </div>
            </div>
          </div>
        )}

        {verificationResult && (
          <div className="result-card">
            <div className={`result-header ${verificationResult.verified ? 'verified' : 'not-verified'}`}>
              <span className={`status-icon ${verificationResult.verified ? 'verified' : 'not-verified'}`}>
                {verificationResult.verified ? '✓' : '✗'}
              </span>
              <span className="result-title">
                {verificationResult.verified ? 'Verification Successful' : 'Verification Failed'}
              </span>
            </div>
            <div className="result-body">
              {verificationResult.verified ? (
                <>
                  <p style={{ color: '#22c55e', marginBottom: '1rem' }}>
                    ✓ The route hash exists on-chain and matches your expected rules and solver version.
                  </p>
                  <div className="data-row">
                    <span className="data-label">Committed At</span>
                    <span className="data-value timestamp">{formatTimestamp(verificationResult.timestamp)}</span>
                  </div>
                </>
              ) : (
                <p style={{ color: '#ef4444' }}>
                  The commitment either doesn't exist or the hashes don't match the expected values.
                  Please verify you have the correct hash values.
                </p>
              )}
            </div>
          </div>
        )}

        <div className="how-it-works">
          <h3>How Verification Works</h3>
          <div className="step-list">
            <div className="step">
              <span className="step-num">1</span>
              <div className="step-content">
                <h4>Get Your Route Details</h4>
                <p>After receiving a quote, Stella provides the route manifest, rules config, and solver version used.</p>
              </div>
            </div>
            <div className="step">
              <span className="step-num">2</span>
              <div className="step-content">
                <h4>Compute Hashes Locally</h4>
                <p>Use SHA-256 to hash each artifact: route_hash = SHA256(route_manifest), etc.</p>
              </div>
            </div>
            <div className="step">
              <span className="step-num">3</span>
              <div className="step-content">
                <h4>Lookup On-Chain</h4>
                <p>Enter the route_hash above to retrieve the commitment stored on the Stellar blockchain.</p>
              </div>
            </div>
            <div className="step">
              <span className="step-num">4</span>
              <div className="step-content">
                <h4>Compare & Verify</h4>
                <p>Verify that rules_hash and solver_version_hash match the published Stella Protocol rules.</p>
              </div>
            </div>
          </div>

          <div className="contract-info">
            <h4>📜 Smart Contract</h4>
            <code>
              Contract: RouteIntegrityRegistry<br/>
              Network: Stellar Testnet / Mainnet<br/>
              Source: <a href="https://github.com/Amitesh007z/stella/tree/main/contracts" style={{ color: '#d4553a' }}>
                github.com/Amitesh007z/stella/contracts
              </a>
            </code>
          </div>
        </div>
      </main>
    </div>
  );
}
