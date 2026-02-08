// ─── Stella Protocol — Execution Service Barrel Export ────────
export { calculateFees, BASE_FEE_XLM } from './feeCalculator.js';
export { estimateSlippage, walkOrderbook, classifySlippage } from './slippageEstimator.js';
export { buildExecutionPlan } from './executionPlanner.js';
export {
  createQuote,
  getQuote,
  refreshQuote,
  getQuoteStats,
  startQuoteCleanup,
  stopQuoteCleanup,
} from './quoteManager.js';
