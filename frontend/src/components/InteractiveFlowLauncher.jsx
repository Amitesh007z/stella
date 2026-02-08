// ─── Interactive Flow Launcher ─────────────────────────────────
// React component for launching SEP-24 interactive flows.
// Uses Freighter wallet for SEP-10 authentication (no secret keys exposed).
// Handles deposit/withdraw initiation, trustline checking, and 
// opening anchor UIs in new tabs/webviews.

import React, { useState, useRef, useEffect } from 'react';
import { toast } from 'react-toastify';
import * as api from '../api';

/**
 * @typedef {object} LaunchConfig
 * @property {'deposit'|'withdraw'} type - Flow type
 * @property {string} anchorDomain - Anchor domain
 * @property {string} [sep24Endpoint] - SEP-24 server URL (optional — auto-discovered by backend)  
 * @property {string} assetCode - Asset code
 * @property {string} assetIssuer - Asset issuer (Stellar assets only)
 * @property {string} amount - Amount to deposit/withdraw
 * @property {string} userAccount - User's Stellar account
 * @property {function} signTransaction - Freighter sign function from wallet hook
 * @property {boolean} [checkTrustline] - Whether to check trustlines first
 * @property {object} [prefill] - Prefill data (email, name, etc.)
 */

export function InteractiveFlowLauncher() {
  const [isLaunching, setIsLaunching] = useState(false);
  const [authStatus, setAuthStatus] = useState('');
  const [activeFlows, setActiveFlows] = useState(new Map());
  const [authTokens, setAuthTokens] = useState(new Map()); // Cache auth tokens
  const popupRef = useRef(null);
  const pollIntervalRef = useRef(null);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
      if (popupRef.current && !popupRef.current.closed) {
        popupRef.current.close();
      }
    };
  }, []);

  /**
   * Get or create auth token for anchor using Freighter
   */
  const getAuthToken = async (config) => {
    const cacheKey = `${config.anchorDomain}:${config.userAccount}`;
    
    // Check local cache first
    const cached = authTokens.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.token;
    }

    // Check backend cache
    try {
      const cachedResult = await api.getCachedToken({
        anchorDomain: config.anchorDomain,
        userPublicKey: config.userAccount
      });
      
      if (cachedResult.hasToken) {
        setAuthTokens(prev => new Map(prev).set(cacheKey, {
          token: cachedResult.token,
          expiresAt: cachedResult.expiresAt
        }));
        return cachedResult.token;
      }
    } catch (e) {
      // Continue to get new token
    }

    // Get new token via SEP-10 flow
    setAuthStatus('Getting authentication challenge...');
    
    // Step 1: Get challenge from anchor
    const challengeResult = await api.getSep10Challenge({
      anchorDomain: config.anchorDomain,
      userPublicKey: config.userAccount
    });

    setAuthStatus('Please sign the authentication request in Freighter...');

    // Step 2: Sign with Freighter
    if (!config.signTransaction) {
      throw new Error('Wallet signing function not available. Make sure you are connected with Freighter.');
    }

    const signedXdr = await config.signTransaction(challengeResult.challengeXdr, {
      networkPassphrase: challengeResult.networkPassphrase
    });

    if (!signedXdr) {
      throw new Error('Challenge signing was cancelled');
    }

    setAuthStatus('Completing authentication...');

    // Step 3: Submit signed challenge
    const tokenResult = await api.submitSep10Response({
      signedXdr,
      authEndpoint: challengeResult.authEndpoint,
      anchorDomain: config.anchorDomain,
      userPublicKey: config.userAccount
    });

    // Cache the token
    setAuthTokens(prev => new Map(prev).set(cacheKey, {
      token: tokenResult.token,
      expiresAt: tokenResult.expiresAt
    }));

    return tokenResult.token;
  };

  /**
   * Launch interactive flow (deposit or withdraw)
   * @param {LaunchConfig} config - Flow configuration
   * @returns {Promise<string>} Transaction ID
   */
  const launchFlow = async (config) => {
    setIsLaunching(true);
    setAuthStatus('');
    
    try {
      // Step 1: Check trustlines if requested
      if (config.checkTrustline && config.assetCode !== 'XLM') {
        await checkTrustlines(config);
      }

      // Step 2: Get auth token via Freighter signing
      const authToken = await getAuthToken(config);

      setAuthStatus('Initiating flow with anchor...');

      // Step 3: Initiate SEP-24 flow
      const response = await api.initiateSep24({
        type: config.type,
        anchorDomain: config.anchorDomain,
        authToken,
        request: {
          assetCode: config.assetCode,
          assetIssuer: config.assetIssuer,
          amount: config.amount,
          account: config.userAccount,
          ...config.prefill
        }
      });

      if (!response.success) {
        throw new Error(response.message || `${config.type} initiation failed`);
      }

      const { url, id } = response;

      // Step 4: Open interactive URL
      const flowWindow = openInteractiveUrl(url, config);
      
      // Step 5: Track flow and poll status
      const flowInfo = {
        id,
        type: config.type,
        assetCode: config.assetCode,
        amount: config.amount,
        anchorDomain: config.anchorDomain,
        authToken, // Store for status polling
        window: flowWindow,
        startedAt: Date.now(),
        status: 'incomplete'
      };

      setActiveFlows(prev => new Map(prev).set(id, flowInfo));
      startStatusPolling(id, config, authToken);

      toast.success(
        `${config.type === 'deposit' ? 'Deposit' : 'Withdraw'} flow launched successfully`,
        { position: 'top-right' }
      );

      setAuthStatus('');
      return id;

    } catch (error) {
      console.error('Flow launch failed:', error);
      setAuthStatus('');
      toast.error(error.message, { position: 'top-right' });
      throw error;
    } finally {
      setIsLaunching(false);
    }
  };

  /**
   * Check trustlines and prompt user if missing
   */
  const checkTrustlines = async (config) => {
    const response = await api.checkTrustlines({
      userPublicKey: config.userAccount,
      assetKeys: [`stellar:${config.assetCode}:${config.assetIssuer}`]
    });

    if (!response.success) {
      throw new Error('Trustline check failed');
    }

    if (response.data?.missingTrustlines?.length > 0) {
      const confirmed = window.confirm(
        `You need to add a trustline for ${config.assetCode} to receive this asset. ` +
        `This requires signing a transaction with your wallet. Continue?`
      );

      if (!confirmed) {
        throw new Error('Trustline creation cancelled by user');
      }

      toast.info(
        'Please add the required trustline using your Stellar wallet before proceeding.',
        { position: 'top-right', autoClose: 8000 }
      );
    }
  };

  /**
   * Open interactive URL in appropriate container
   */
  const openInteractiveUrl = (url, config) => {
    const windowFeatures = 'width=800,height=600,scrollbars=yes,resizable=yes';
    const flowWindow = window.open(url, `sep24_${config.type}`, windowFeatures);

    if (!flowWindow) {
      toast.warning(
        'Popup blocked. Opening in current tab...',
        { position: 'top-right' }
      );
      window.location.href = url;
      return null;
    }

    flowWindow.focus();
    return flowWindow;
  };

  /**
   * Poll transaction status
   */
  const startStatusPolling = (transactionId, config, authToken) => {
    const pollInterval = setInterval(async () => {
      try {
        const status = await api.getSep24Status(transactionId, {
          anchorDomain: config.anchorDomain,
          authToken
        });
        
        setActiveFlows(prev => {
          const updated = new Map(prev);
          const flow = updated.get(transactionId);
          if (flow) {
            updated.set(transactionId, { ...flow, status: status.status });
          }
          return updated;
        });

        // Stop polling on completion or error
        if (['completed', 'error', 'refunded'].includes(status.status)) {
          clearInterval(pollInterval);
          
          const message = status.status === 'completed' 
            ? `${config.type === 'deposit' ? 'Deposit' : 'Withdraw'} completed successfully!`
            : `${config.type === 'deposit' ? 'Deposit' : 'Withdraw'} ${status.status}`;
            
          toast.info(message, { position: 'top-right' });
        }

      } catch (error) {
        console.error('Status polling failed:', error);
      }
    }, 5000);

    pollIntervalRef.current = pollInterval;

    // Auto-cleanup after 30 minutes
    setTimeout(() => {
      clearInterval(pollInterval);
    }, 30 * 60 * 1000);
  };

  /**
   * Close flow and cleanup
   */
  const closeFlow = (transactionId) => {
    setActiveFlows(prev => {
      const updated = new Map(prev);
      const flow = updated.get(transactionId);
      
      if (flow && flow.window && !flow.window.closed) {
        flow.window.close();
      }
      
      updated.delete(transactionId);
      return updated;
    });
  };

  return {
    launchFlow,
    isLaunching,
    authStatus,
    activeFlows: Array.from(activeFlows.values()),
    closeFlow
  };
}

/**
 * Hook for using interactive flows
 */
export function useInteractiveFlows() {
  return InteractiveFlowLauncher();
}

/**
 * Simple launcher button component
 */
export function LaunchButton({ 
  config, 
  children = 'Launch', 
  className = '',
  disabled = false 
}) {
  const { launchFlow, isLaunching } = useInteractiveFlows();

  const handleClick = async () => {
    try {
      await launchFlow(config);
    } catch (error) {
      // Error already handled in launchFlow
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={disabled || isLaunching}
      className={`px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 ${className}`}
    >
      {isLaunching ? 'Launching...' : children}
    </button>
  );
}

/**
 * Flow status indicator component
 */
export function FlowStatusIndicator({ flows }) {
  if (flows.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 space-y-2">
      {flows.map(flow => (
        <div 
          key={flow.id}
          className="bg-white border border-gray-200 rounded-lg shadow-lg p-3 min-w-64"
        >
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium">
                {flow.type === 'deposit' ? '↓' : '↑'} {flow.assetCode} {flow.amount}
              </div>
              <div className="text-sm text-gray-500">
                {flow.anchorDomain}
              </div>
            </div>
            <div className="text-right">
              <div className={`text-sm font-medium ${
                flow.status === 'completed' ? 'text-green-600' :
                flow.status === 'error' ? 'text-red-600' :
                'text-yellow-600'
              }`}>
                {flow.status}
              </div>
              <button 
                onClick={() => closeFlow(flow.id)}
                className="text-xs text-gray-400 hover:text-gray-600"
              >
                ×
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}