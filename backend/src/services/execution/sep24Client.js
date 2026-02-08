// ─── SEP-24 Interactive Deposit/Withdraw Client ────────────────
// Implements SEP-24 API client for initiating interactive deposit/withdraw
// flows with anchors. Returns URLs that open anchor-hosted UIs.
//
// Flow:
// 1. Call POST /transactions/deposit/interactive → {url, id}
// 2. Open URL in webview/new tab for user KYC/payment
// 3. Poll GET /transaction/{id} for status updates
// 4. Handle completion/failure

import { sep10AuthService } from '../auth/sep10AuthService.js';
import { createLogger } from '../../lib/logger.js';

const log = createLogger('sep24-client');

/**
 * @typedef {object} TransactionRequest
 * @property {string} assetCode - Asset code (e.g., 'USD', 'BTC')
 * @property {string} assetIssuer - Asset issuer public key (Stellar assets only)
 * @property {string} amount - Amount to deposit/withdraw
 * @property {string} account - User's Stellar account public key 
 * @property {string} [memo] - Optional memo
 * @property {string} [memoType] - Memo type ('text', 'id', 'hash', 'return')
 * @property {string} [email] - User email for prefill
 * @property {string} [firstName] - First name for prefill
 * @property {string} [lastName] - Last name for prefill
 * @property {string} [lang] - Language preference (ISO 639-1)
 */

/**
 * @typedef {object} InteractiveResponse  
 * @property {string} type - Response type ('interactive_customer_info_needed')
 * @property {string} url - Interactive flow URL
 * @property {string} id - Transaction ID for status polling
 */

/**
 * @typedef {object} TransactionStatus
 * @property {string} id - Transaction ID
 * @property {'incomplete'|'pending_user_transfer_start'|'pending_anchor'|'pending_stellar'|'pending_external'|'pending_trust'|'pending_user'|'completed'|'error'} status - Status
 * @property {number} [statusEta] - ETA in seconds
 * @property {string} [moreInfoUrl] - URL for more info
 * @property {string} [amountIn] - Input amount
 * @property {string} [amountOut] - Output amount  
 * @property {string} [amountFee] - Fee amount
 * @property {string} [startedAt] - ISO timestamp
 * @property {string} [completedAt] - ISO timestamp
 * @property {string} [stellarTransactionId] - Stellar transaction hash
 * @property {string} [externalTransactionId] - External system transaction ID
 * @property {string} [message] - Human-readable status message
 * @property {boolean] refunded - Whether transaction was refunded
 */

class SEP24Client {

  /**
   * Initiate interactive deposit flow
   * @param {string} anchorDomain - Anchor domain
   * @param {string} sep24Endpoint - SEP-24 server URL
   * @param {TransactionRequest} request - Deposit request
   * @param {string} userSecretKey - User's secret key for SEP-10 auth
   * @returns {Promise<InteractiveResponse>} Interactive flow details
   */
  async initiateDeposit(anchorDomain, sep24Endpoint, request, userSecretKey) {
    log.info({ 
      anchorDomain, 
      assetCode: request.assetCode, 
      amount: request.amount,
      account: request.account 
    }, 'Initiating SEP-24 deposit');

    try {
      // Get auth token
      const authToken = await sep10AuthService.getAuthToken(
        anchorDomain, 
        request.account, 
        userSecretKey
      );

      // Prepare deposit request
      const depositUrl = new URL('/transactions/deposit/interactive', sep24Endpoint);
      const formData = new URLSearchParams();
      
      formData.set('asset_code', request.assetCode);
      if (request.assetIssuer) {
        formData.set('asset_issuer', request.assetIssuer);
      }
      if (request.amount) {
        formData.set('amount', request.amount);  
      }
      formData.set('account', request.account);
      
      // Optional fields for prefill
      if (request.memo) formData.set('memo', request.memo);
      if (request.memoType) formData.set('memo_type', request.memoType);
      if (request.email) formData.set('email_address', request.email);
      if (request.firstName) formData.set('first_name', request.firstName);
      if (request.lastName) formData.set('last_name', request.lastName);
      if (request.lang) formData.set('lang', request.lang);

      const response = await fetch(depositUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authToken.token}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        },
        body: formData,
        timeout: 15000
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Deposit initiation failed: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const data = await response.json();

      if (data.type !== 'interactive_customer_info_needed') {
        throw new Error(`Unexpected response type: ${data.type}`);
      }

      if (!data.url || !data.id) {
        throw new Error('Missing required fields in deposit response (url, id)');
      }

      log.info({
        anchorDomain,
        transactionId: data.id,
        assetCode: request.assetCode
      }, 'SEP-24 deposit initiated successfully');

      return {
        type: data.type,
        url: data.url,
        id: data.id
      };

    } catch (error) {
      log.error({
        error: error.message,
        anchorDomain,
        assetCode: request.assetCode,
        account: request.account
      }, 'SEP-24 deposit initiation failed');
      throw error;
    }
  }

  /**
   * Initiate interactive withdraw flow
   * @param {string} anchorDomain - Anchor domain
   * @param {string} sep24Endpoint - SEP-24 server URL  
   * @param {TransactionRequest} request - Withdraw request
   * @param {string} userSecretKey - User's secret key for SEP-10 auth
   * @returns {Promise<InteractiveResponse>} Interactive flow details
   */
  async initiateWithdraw(anchorDomain, sep24Endpoint, request, userSecretKey) {
    log.info({
      anchorDomain,
      assetCode: request.assetCode,
      amount: request.amount,
      account: request.account
    }, 'Initiating SEP-24 withdraw');

    try {
      // Get auth token
      const authToken = await sep10AuthService.getAuthToken(
        anchorDomain,
        request.account,
        userSecretKey
      );

      // Prepare withdraw request
      const withdrawUrl = new URL('/transactions/withdraw/interactive', sep24Endpoint);
      const formData = new URLSearchParams();

      formData.set('asset_code', request.assetCode);
      if (request.assetIssuer) {
        formData.set('asset_issuer', request.assetIssuer);
      }
      if (request.amount) {
        formData.set('amount', request.amount);
      }
      formData.set('account', request.account);

      // Optional fields
      if (request.memo) formData.set('memo', request.memo);
      if (request.memoType) formData.set('memo_type', request.memoType);
      if (request.email) formData.set('email_address', request.email);
      if (request.firstName) formData.set('first_name', request.firstName);
      if (request.lastName) formData.set('last_name', request.lastName);
      if (request.lang) formData.set('lang', request.lang);

      const response = await fetch(withdrawUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authToken.token}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        },
        body: formData,
        timeout: 15000
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Withdraw initiation failed: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const data = await response.json();

      if (data.type !== 'interactive_customer_info_needed') {
        throw new Error(`Unexpected response type: ${data.type}`);
      }

      if (!data.url || !data.id) {
        throw new Error('Missing required fields in withdraw response (url, id)');
      }

      log.info({
        anchorDomain,
        transactionId: data.id,
        assetCode: request.assetCode
      }, 'SEP-24 withdraw initiated successfully');

      return {
        type: data.type,
        url: data.url,
        id: data.id
      };

    } catch (error) {
      log.error({
        error: error.message,
        anchorDomain,
        assetCode: request.assetCode,
        account: request.account
      }, 'SEP-24 withdraw initiation failed');
      throw error;
    }
  }

  /**
   * Get transaction status by ID
   * @param {string} anchorDomain - Anchor domain
   * @param {string} sep24Endpoint - SEP-24 server URL 
   * @param {string} transactionId - Transaction ID
   * @param {string} userAccount - User's Stellar account
   * @param {string} userSecretKey - User's secret key for auth
   * @returns {Promise<TransactionStatus>} Transaction status
   */
  async getTransactionStatus(anchorDomain, sep24Endpoint, transactionId, userAccount, userSecretKey) {
    try {
      // Get auth token
      const authToken = await sep10AuthService.getAuthToken(
        anchorDomain,
        userAccount,
        userSecretKey
      );

      const statusUrl = new URL('/transaction', sep24Endpoint);
      statusUrl.searchParams.set('id', transactionId);

      const response = await fetch(statusUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${authToken.token}`,
          'Accept': 'application/json'
        },
        timeout: 10000
      });

      if (!response.ok) {
        throw new Error(`Status check failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();

      if (!data.transaction) {
        throw new Error('Status response missing transaction data');
      }

      return data.transaction;

    } catch (error) {
      log.error({
        error: error.message,
        anchorDomain,
        transactionId
      }, 'SEP-24 status check failed');
      throw error;
    }
  }

  /**
   * Get info about anchor's SEP-24 capabilities
   * @param {string} sep24Endpoint - SEP-24 server URL
   * @returns {Promise<object>} Info response
   */
  async getInfo(sep24Endpoint) {
    try {
      const infoUrl = new URL('/info', sep24Endpoint);

      const response = await fetch(infoUrl, {
        method: 'GET', 
        headers: {
          'Accept': 'application/json'
        },
        timeout: 10000
      });

      if (!response.ok) {
        throw new Error(`Info request failed: ${response.status} ${response.statusText}`);
      }

      return await response.json();

    } catch (error) {
      log.error({
        error: error.message,
        sep24Endpoint
      }, 'SEP-24 info request failed');
      throw error;
    }
  }
}

export const sep24Client = new SEP24Client();