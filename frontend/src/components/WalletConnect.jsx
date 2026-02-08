// ─── Wallet Connection UI Component ───────────────────────────
// "Connect Wallet" button for Freighter wallet integration.
// Freighter = Stellar's browser extension wallet — signs transactions
// securely without exposing the secret key.

import { useState } from 'react';

/**
 * @param {{ wallet: ReturnType<import('../hooks').useWallet> }} props
 */
export default function WalletConnect({ wallet }) {
  const {
    publicKey, walletType, status, freighterAvail, error,
    isConnected, connect, disconnect,
  } = wallet;

  // ── Connected state ─────────────────────────────────────────
  if (isConnected) {
    return (
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '10px 14px', background: 'rgba(34,197,94,0.08)',
        borderRadius: 6, border: '1px solid rgba(34,197,94,0.25)',
      }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              background: 'var(--success)', display: 'inline-block',
            }} />
            <span style={{ fontSize: 13, fontWeight: 600 }}>
              🔐 Freighter Connected
            </span>
          </div>
          <div style={{
            fontSize: 11, fontFamily: 'var(--font-mono)',
            color: 'var(--text-muted)', marginTop: 2,
          }}>
            {publicKey.slice(0, 12)}…{publicKey.slice(-6)}
          </div>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={disconnect} style={{ fontSize: 11 }}>
          Disconnect
        </button>
      </div>
    );
  }

  // ── Disconnected state ──────────────────────────────────────
  return (
    <div>
      {/* Primary action */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          className="btn btn-primary"
          onClick={connect}
          disabled={status === 'connecting'}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            opacity: freighterAvail ? 1 : 0.6,
          }}
        >
          {status === 'connecting' ? '⏳ Connecting…' : '🔐 Connect Freighter'}
        </button>

        {!freighterAvail && (
          <a
            href="https://freighter.app"
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 12, color: 'var(--accent)', textDecoration: 'none' }}
          >
            Get Freighter →
          </a>
        )}
      </div>

      {/* Error message */}
      {error && (
        <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 6 }}>
          {error}
        </div>
      )}

      {/* Freighter info */}
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
        Freighter is a free browser extension for Stellar — like MetaMask for Ethereum.
        It securely stores your keys and signs transactions without exposing your secret key.
      </div>
    </div>
  );
}
