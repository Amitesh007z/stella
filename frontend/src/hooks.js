// ─── Stella Protocol — Custom Hooks ───────────────────────────
import { useState, useEffect, useCallback, useRef } from 'react';

/**
 * Generic data-fetching hook with loading/error state.
 */
export function useFetch(fetchFn, deps = []) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchFn()
      .then(setData)
      .catch((e) => setError(e.message || String(e)))
      .finally(() => setLoading(false));
  }, deps);

  useEffect(() => { refetch(); }, [refetch]);

  return { data, loading, error, refetch };
}

/**
 * Auto-refresh hook — polls a fetcher on an interval.
 */
export function usePolling(fetchFn, intervalMs = 10000) {
  const result = useFetch(fetchFn, []);

  useEffect(() => {
    const id = setInterval(result.refetch, intervalMs);
    return () => clearInterval(id);
  }, [result.refetch, intervalMs]);

  return result;
}

/**
 * Format a number nicely.
 */
export function fmt(n, decimals = 2) {
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

/**
 * Truncate a Stellar public key.
 */
export function truncKey(key) {
  if (!key || key === 'native') return 'native';
  if (key.length <= 12) return key;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

/**
 * Relative time string.
 */
export function timeAgo(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

// ─── Stellar Wallet Hook (Freighter) ──────────────────────────
// Uses @stellar/freighter-api v6 to communicate with the Freighter
// browser extension via Chrome messaging. The extension does NOT
// inject window globals — you MUST use this package.
//
// v6 API: getAddress (not getPublicKey), signTransaction uses { address }

import {
  isConnected   as freighterIsConnected,
  isAllowed     as freighterIsAllowed,
  requestAccess as freighterRequestAccess,
  getAddress    as freighterGetAddress,
  signTransaction as freighterSignTx,
} from '@stellar/freighter-api';

const WALLET_KEY = 'stella_wallet';

/**
 * Detect whether the Freighter extension is installed & reachable.
 * isConnected() from the package returns { isConnected: boolean } or a boolean
 * depending on the version.
 */
async function detectFreighter() {
  try {
    const result = await freighterIsConnected();
    // v2 returns { isConnected: bool }, v1 returns bool
    return typeof result === 'boolean' ? result : !!result?.isConnected;
  } catch {
    return false;
  }
}

/**
 * Hook for connecting to a Stellar wallet.
 *
 * Tries Freighter first (secure — secret key never leaves extension).
 * Falls back to manual key entry for users without Freighter.
 */
export function useWallet() {
  const [publicKey, setPublicKey] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [walletType, setWalletType] = useState('manual');
  const [status, setStatus] = useState('disconnected');
  const [freighterAvail, setFreighterAvail] = useState(false);
  const [error, setError] = useState(null);
  const checkedRef = useRef(false);

  // Persist wallet choice to localStorage
  const persist = useCallback((type, pk) => {
    try { localStorage.setItem(WALLET_KEY, JSON.stringify({ type, pk })); } catch { /* */ }
  }, []);

  // Silently reconnect Freighter on page load
  const reconnect = useCallback(async (expectedPk) => {
    try {
      const allowed = await freighterIsAllowed();
      const isOk = typeof allowed === 'boolean' ? allowed : !!allowed?.isAllowed;
      if (!isOk) return;
      // v6: getAddress returns { address: string }
      const addrResult = await freighterGetAddress();
      const pk = typeof addrResult === 'string' ? addrResult : addrResult?.address;
      if (pk && (!expectedPk || pk === expectedPk)) {
        setPublicKey(pk); setWalletType('freighter'); setStatus('connected');
        persist('freighter', pk);
      }
    } catch { /* silent */ }
  }, [persist]);

  // Detect Freighter on mount + restore saved state
  useEffect(() => {
    if (checkedRef.current) return;
    checkedRef.current = true;

    const detect = async () => {
      const avail = await detectFreighter();
      setFreighterAvail(avail);
      try {
        const saved = JSON.parse(localStorage.getItem(WALLET_KEY) || 'null');
        if (saved?.type === 'freighter' && avail) reconnect(saved.pk);
        else if (saved?.type === 'manual' && saved.pk) {
          setPublicKey(saved.pk); setWalletType('manual'); setStatus('manual');
        }
      } catch { /* */ }
    };

    // Check immediately, then again after 1s (extension can be slow)
    detect();
    const timer = setTimeout(detect, 1000);
    return () => clearTimeout(timer);
  }, [reconnect]);

  // Connect via Freighter
  const connect = useCallback(async () => {
    setError(null);

    // Re-check availability (may have loaded since mount)
    const avail = await detectFreighter();
    setFreighterAvail(avail);

    if (!avail) {
      setError('Freighter not detected. Make sure the extension is installed & enabled, then reload the page.');
      return false;
    }

    setStatus('connecting');
    try {
      // v6: requestAccess returns { address: string }
      const accessResult = await freighterRequestAccess();
      let pk = typeof accessResult === 'string'
        ? accessResult
        : accessResult?.address;

      // Fallback: try getAddress if requestAccess returned empty
      if (!pk) {
        const addrResult = await freighterGetAddress();
        pk = typeof addrResult === 'string' ? addrResult : addrResult?.address;
      }

      if (!pk) throw new Error('No public key returned — user may have rejected the request');

      setPublicKey(pk); setSecretKey(''); setWalletType('freighter'); setStatus('connected');
      persist('freighter', pk);
      return true;
    } catch (err) {
      setStatus('disconnected');
      setError(err?.message || 'Freighter connection failed');
      return false;
    }
  }, [persist]);

  // Manual key entry
  const setManualKeys = useCallback((pk, sk) => {
    setPublicKey(pk || ''); setSecretKey(sk || '');
    setWalletType('manual'); setStatus(pk ? 'manual' : 'disconnected');
    persist('manual', pk || ''); setError(null);
  }, [persist]);

  // Disconnect
  const disconnect = useCallback(() => {
    setPublicKey(''); setSecretKey(''); setWalletType('manual');
    setStatus('disconnected'); setError(null);
    try { localStorage.removeItem(WALLET_KEY); } catch { /* */ }
  }, []);

  // Sign XDR via Freighter (for SEP-10 challenges — no secret key needed)
  const signTransaction = useCallback(async (xdr, opts = {}) => {
    if (walletType !== 'freighter') throw new Error('Only available in Freighter mode');
    try {
      const network = opts.networkPassphrase || 'Test SDF Network ; September 2015';
      // v6 API: uses 'address' not 'accountToSign'
      const result = await freighterSignTx(xdr, {
        networkPassphrase: network,
        address: opts.accountToSign || publicKey,
      });
      // v6 returns { signedTxXdr: string, signerAddress: string }
      return typeof result === 'string' ? result : result?.signedTxXdr;
    } catch (err) {
      if (err?.message?.includes('User declined')) throw new Error('Signing cancelled by user');
      throw err;
    }
  }, [walletType, publicKey]);

  return {
    publicKey, secretKey, walletType, status, freighterAvail, error,
    isConnected: status === 'connected' || status === 'manual',
    connect, disconnect, setManualKeys, signTransaction,
  };
}
