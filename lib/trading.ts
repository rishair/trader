/**
 * Trading Execution Library
 *
 * Handles ALL validation, state transitions, and approval logic for trades.
 * Models should use this library instead of manually updating portfolio.json.
 *
 * This removes cognitive overhead from models - they focus on "should we trade?"
 * while this code handles "can we trade?" and "how do we trade?"
 */

import * as fs from 'fs';
import * as path from 'path';
import { sendMessage } from '../tools/telegram/bot';
import { hasTradeValidation, addEvidence, recordTradeResult } from './hypothesis';
import { requestCapability } from './handoffs';

const STATE_DIR = path.join(__dirname, '..', 'state');
const PORTFOLIO_FILE = path.join(STATE_DIR, 'trading/portfolio.json');
const APPROVALS_FILE = path.join(STATE_DIR, 'shared/pending_approvals.json');

// ============================================================================
// Types
// ============================================================================

export interface ExitCriteria {
  takeProfit: number;      // Price to exit with profit (e.g., 0.20 = 20¢)
  stopLoss: number;        // Price to exit with loss (e.g., 0.04 = 4¢)
  timeLimit?: string;      // ISO date - exit by this time
  notes?: string;
}

export interface TradeParams {
  market: string;          // Market slug
  marketQuestion?: string; // Human-readable question
  direction: 'YES' | 'NO';
  outcome?: string;        // For multi-outcome markets (e.g., "Apple")
  amount: number;          // USD to spend
  price: number;           // Expected entry price (0-1)
  hypothesisId: string;
  rationale: string;
  exitCriteria: ExitCriteria;
  tokenId?: string;        // For API execution
}

export interface TradeResult {
  success: boolean;
  tradeId?: string;
  error?: string;
  requiresApproval?: boolean;
  approvalId?: string;
  shares?: number;
  cost?: number;
}

export interface Position {
  id: string;
  market: string;
  marketSlug: string;
  platform: string;
  direction: 'YES' | 'NO';
  outcome?: string;
  entryPrice: number;
  shares: number;
  cost: number;
  currentPrice: number;
  unrealizedPnL: number;
  strategyId?: string;
  hypothesisId: string;
  entryDate: string;
  exitCriteria: ExitCriteria;
  rationale: string;
  tokenId?: string;
}

export interface Portfolio {
  cash: number;
  startingCapital: number;
  positions: Position[];
  tradeHistory: any[];
  metrics: {
    totalReturn: number;
    totalReturnPct: number;
    realizedPnL: number;
    unrealizedPnL: number;
    winCount: number;
    lossCount: number;
    winRate: number;
  };
  lastUpdated?: string;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
  warnings?: string[];
}

export type ApprovalTier = 'auto' | 'notify' | 'approve';

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  // Position limits
  maxSingleMarketPct: 0.20,      // Max 20% in any single market
  maxConcurrentPositions: 10,
  minCashReservePct: 0.20,       // Keep 20% cash reserve

  // Approval tiers (USD)
  autoApproveLimit: 50,          // Auto-execute trades <= $50
  notifyLimit: 200,              // Notify but don't wait for trades <= $200
  // Above $200 requires explicit approval

  // Trade constraints
  minTradeSize: 5,               // Don't bother with trades < $5
  maxTradeSize: 2000,            // Safety cap
};

// ============================================================================
// Core Functions
// ============================================================================

export function loadPortfolio(): Portfolio {
  try {
    return JSON.parse(fs.readFileSync(PORTFOLIO_FILE, 'utf-8'));
  } catch (error) {
    throw new Error(`Failed to load portfolio: ${error}`);
  }
}

export function savePortfolio(portfolio: Portfolio): void {
  portfolio.lastUpdated = new Date().toISOString();
  fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(portfolio, null, 2));
}

/**
 * Validate a trade against all constraints.
 * Code enforces rules - models don't need to remember them.
 */
export function validateTrade(params: TradeParams, portfolio: Portfolio): ValidationResult {
  const warnings: string[] = [];

  // Basic sanity checks
  if (params.amount < CONFIG.minTradeSize) {
    return { valid: false, error: `Trade size $${params.amount} below minimum $${CONFIG.minTradeSize}` };
  }

  if (params.amount > CONFIG.maxTradeSize) {
    return { valid: false, error: `Trade size $${params.amount} exceeds safety cap $${CONFIG.maxTradeSize}` };
  }

  if (params.price <= 0 || params.price >= 1) {
    return { valid: false, error: `Invalid price ${params.price} - must be between 0 and 1` };
  }

  // Cash check
  if (params.amount > portfolio.cash) {
    return { valid: false, error: `Insufficient cash: have $${portfolio.cash.toFixed(2)}, need $${params.amount}` };
  }

  // Cash reserve check
  const minCash = portfolio.startingCapital * CONFIG.minCashReservePct;
  if (portfolio.cash - params.amount < minCash) {
    return { valid: false, error: `Would breach $${minCash.toFixed(2)} cash reserve (${CONFIG.minCashReservePct * 100}% of starting capital)` };
  }

  // Position limit check
  const existingPosition = portfolio.positions.find(p => p.marketSlug === params.market);
  if (!existingPosition && portfolio.positions.length >= CONFIG.maxConcurrentPositions) {
    return { valid: false, error: `Already at ${CONFIG.maxConcurrentPositions} position limit` };
  }

  // Single market concentration check
  const currentMarketExposure = existingPosition ? existingPosition.cost : 0;
  const totalPortfolioValue = portfolio.cash + portfolio.positions.reduce((sum, p) => sum + p.cost, 0);
  const newExposurePct = (currentMarketExposure + params.amount) / totalPortfolioValue;

  if (newExposurePct > CONFIG.maxSingleMarketPct) {
    return {
      valid: false,
      error: `Would exceed ${CONFIG.maxSingleMarketPct * 100}% single market limit (${(newExposurePct * 100).toFixed(1)}%)`
    };
  }

  // Exit criteria validation
  if (!params.exitCriteria.takeProfit || !params.exitCriteria.stopLoss) {
    return { valid: false, error: 'Exit criteria (takeProfit and stopLoss) are required' };
  }

  if (params.exitCriteria.stopLoss >= params.price) {
    warnings.push(`Stop loss (${params.exitCriteria.stopLoss}) >= entry price (${params.price})`);
  }

  if (params.exitCriteria.takeProfit <= params.price) {
    warnings.push(`Take profit (${params.exitCriteria.takeProfit}) <= entry price (${params.price})`);
  }

  // Hypothesis check
  if (!params.hypothesisId) {
    return { valid: false, error: 'Trade must be linked to a hypothesis' };
  }

  // Tiered backtest gate: trades >$50 require validation
  if (params.amount > CONFIG.autoApproveLimit) {
    const validation = hasTradeValidation(params.hypothesisId);
    if (!validation.validated) {
      // Create handoff to agent-engineer for capability if validation requires something we don't have
      if (validation.reason?.includes('backtest') || validation.reason?.includes('validation')) {
        requestCapability(
          `Need validation capability for hypothesis ${params.hypothesisId}`,
          {
            hypothesisId: params.hypothesisId,
            market: params.market,
            tradeAmount: params.amount,
            validationReason: validation.reason,
          },
          'high'
        );
        console.log(`[Trading] Created handoff: validation capability needed for ${params.hypothesisId}`);
      }
      return {
        valid: false,
        error: `Trade >$${CONFIG.autoApproveLimit} requires validation. ${validation.reason}`,
      };
    }
    // Add validation info to warnings for visibility
    warnings.push(`Validation: ${validation.reason}`);
  }

  return { valid: true, warnings: warnings.length > 0 ? warnings : undefined };
}

/**
 * Determine approval tier based on trade size and type.
 */
export function getApprovalTier(params: TradeParams): ApprovalTier {
  if (params.amount <= CONFIG.autoApproveLimit) {
    return 'auto';
  }
  if (params.amount <= CONFIG.notifyLimit) {
    return 'notify';
  }
  return 'approve';
}

/**
 * Create an approval request for CEO review.
 */
async function createApproval(params: TradeParams): Promise<string> {
  const approvals = JSON.parse(fs.readFileSync(APPROVALS_FILE, 'utf-8'));

  const approvalId = `trade-${Date.now().toString(36)}`;

  approvals.approvals.push({
    id: approvalId,
    type: 'trade',
    title: `${params.direction} ${params.outcome || params.market} @ ${(params.price * 100).toFixed(1)}¢`,
    description: params.rationale,
    proposedAt: new Date().toISOString(),
    status: 'pending',
    context: {
      ...params,
      tier: 'approve',
    }
  });

  fs.writeFileSync(APPROVALS_FILE, JSON.stringify(approvals, null, 2));

  // Notify CEO
  await sendMessage(
    `📋 *Trade Approval Needed*\n\n` +
    `${params.direction} ${params.outcome || params.market}\n` +
    `Amount: $${params.amount}\n` +
    `Price: ${(params.price * 100).toFixed(1)}¢\n` +
    `Hypothesis: ${params.hypothesisId}\n\n` +
    `Rationale: ${params.rationale.slice(0, 200)}...\n\n` +
    `Reply: /approve ${approvalId} or /reject ${approvalId}`
  );

  return approvalId;
}

/**
 * Execute a paper trade. Handles validation, approval, and state updates.
 *
 * Models call this function - they don't need to:
 * - Check position limits
 * - Validate cash reserves
 * - Update portfolio.json manually
 * - Handle approval logic
 */
export async function executePaperTrade(params: TradeParams): Promise<TradeResult> {
  // 1. Load current portfolio
  const portfolio = loadPortfolio();

  // 2. Validate (code enforces all rules)
  const validation = validateTrade(params, portfolio);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  // 3. Check approval tier
  const tier = getApprovalTier(params);

  if (tier === 'approve') {
    const approvalId = await createApproval(params);
    return {
      success: false,
      requiresApproval: true,
      approvalId,
      error: `Trade requires CEO approval (>$${CONFIG.notifyLimit})`
    };
  }

  // 4. Execute the trade
  const shares = Math.floor(params.amount / params.price);
  const actualCost = shares * params.price;
  const tradeId = `trade-${Date.now().toString(36)}`;

  const position: Position = {
    id: tradeId,
    market: params.marketQuestion || params.market,
    marketSlug: params.market,
    platform: 'Polymarket',
    direction: params.direction,
    outcome: params.outcome,
    entryPrice: params.price,
    shares,
    cost: actualCost,
    currentPrice: params.price,
    unrealizedPnL: 0,
    hypothesisId: params.hypothesisId,
    entryDate: new Date().toISOString(),
    exitCriteria: params.exitCriteria,
    rationale: params.rationale,
    tokenId: params.tokenId,
  };

  // Update portfolio
  portfolio.cash -= actualCost;
  portfolio.positions.push(position);
  portfolio.tradeHistory.push({
    tradeId,
    type: 'ENTRY',
    timestamp: new Date().toISOString(),
    market: position.market,
    marketSlug: position.marketSlug,
    direction: position.direction,
    outcome: position.outcome,
    price: position.entryPrice,
    shares: position.shares,
    cost: position.cost,
    hypothesisId: position.hypothesisId,
    rationale: position.rationale,
    cashAfter: portfolio.cash,
  });

  // Recalculate metrics
  updatePortfolioMetrics(portfolio);

  // Save
  savePortfolio(portfolio);

  // 5. Add evidence to hypothesis (feedback loop)
  try {
    addEvidence(
      params.hypothesisId,
      `Trade executed: ${params.direction} ${shares} shares @ ${(params.price * 100).toFixed(1)}¢. Cost: $${actualCost.toFixed(2)}. Rationale: ${params.rationale.slice(0, 100)}`,
      null, // neutral - entry doesn't confirm/deny hypothesis yet
      0     // no confidence change on entry
    );
    console.log(`[Trading] Added entry evidence to ${params.hypothesisId}`);
  } catch (error: any) {
    console.log(`[Trading] Could not add entry evidence: ${error.message}`);
  }

  // 6. Notify based on tier
  if (tier === 'notify') {
    await sendMessage(
      `📈 *Trade Executed*\n\n` +
      `${params.direction} ${params.outcome || params.market}\n` +
      `Shares: ${shares} @ ${(params.price * 100).toFixed(1)}¢\n` +
      `Cost: $${actualCost.toFixed(2)}\n` +
      `Hypothesis: ${params.hypothesisId}\n\n` +
      `Cash remaining: $${portfolio.cash.toFixed(2)}`
    );
  }

  // Log for auto-approved trades (silent execution)
  console.log(`[Trading] Executed ${tradeId}: ${params.direction} ${shares} shares @ ${params.price}`);

  return {
    success: true,
    tradeId,
    shares,
    cost: actualCost
  };
}

/**
 * Exit a position. Handles validation and state updates.
 */
export async function exitPosition(
  positionId: string,
  exitPrice: number,
  reason: string
): Promise<TradeResult> {
  const portfolio = loadPortfolio();

  const positionIndex = portfolio.positions.findIndex(p => p.id === positionId);
  if (positionIndex === -1) {
    return { success: false, error: `Position ${positionId} not found` };
  }

  const position = portfolio.positions[positionIndex];
  const proceeds = position.shares * exitPrice;
  const pnl = proceeds - position.cost;

  // Remove position
  portfolio.positions.splice(positionIndex, 1);

  // Add cash
  portfolio.cash += proceeds;

  // Record in history
  portfolio.tradeHistory.push({
    id: `exit-${Date.now().toString(36)}`,
    type: 'EXIT',
    timestamp: new Date().toISOString(),
    positionId: position.id,
    market: position.market,
    marketSlug: position.marketSlug,
    direction: position.direction,
    outcome: position.outcome,
    entryPrice: position.entryPrice,
    exitPrice,
    shares: position.shares,
    proceeds,
    pnl,
    pnlPct: pnl / position.cost,
    reason,
    cashAfter: portfolio.cash,
    hypothesisId: position.hypothesisId,
  });

  // Update metrics
  if (pnl > 0) {
    portfolio.metrics.winCount++;
  } else {
    portfolio.metrics.lossCount++;
  }
  portfolio.metrics.realizedPnL += pnl;
  updatePortfolioMetrics(portfolio);

  savePortfolio(portfolio);

  // FEEDBACK LOOP: Update hypothesis with trade result
  if (position.hypothesisId) {
    try {
      const won = pnl > 0;

      // Record the trade result (updates testResults on hypothesis)
      recordTradeResult(position.hypothesisId, won, pnl);

      // Calculate confidence impact based on P&L magnitude
      const pnlPct = Math.abs(pnl / position.cost);
      const confidenceImpact = won
        ? (pnlPct > 0.20 ? 0.08 : 0.04)   // big win vs small win
        : (pnlPct > 0.20 ? -0.10 : -0.05); // big loss vs small loss

      // Add evidence with result
      addEvidence(
        position.hypothesisId,
        `Trade closed: ${won ? 'WIN' : 'LOSS'} $${pnl.toFixed(2)} (${(pnl / position.cost * 100).toFixed(1)}%). ${reason}`,
        won,
        confidenceImpact
      );

      console.log(`[Trading] Recorded ${won ? 'winning' : 'losing'} trade for ${position.hypothesisId} (confidence ${confidenceImpact >= 0 ? '+' : ''}${(confidenceImpact * 100).toFixed(0)}%)`);
    } catch (error: any) {
      console.log(`[Trading] Could not record trade result: ${error.message}`);
    }
  }

  // Notify
  const pnlSign = pnl >= 0 ? '+' : '';
  await sendMessage(
    `${pnl >= 0 ? '✅' : '❌'} *Position Closed*\n\n` +
    `${position.direction} ${position.outcome || position.market}\n` +
    `Entry: ${(position.entryPrice * 100).toFixed(1)}¢ → Exit: ${(exitPrice * 100).toFixed(1)}¢\n` +
    `P&L: ${pnlSign}$${pnl.toFixed(2)} (${pnlSign}${(pnl / position.cost * 100).toFixed(1)}%)\n` +
    `Reason: ${reason}\n\n` +
    `Cash: $${portfolio.cash.toFixed(2)}`
  );

  return { success: true, tradeId: position.id };
}

/**
 * Check exit triggers for all positions.
 * Called by price-tracker pipeline.
 */
export function checkExitTriggers(portfolio: Portfolio): Array<{
  position: Position;
  trigger: 'takeProfit' | 'stopLoss' | 'timeLimit';
  currentPrice: number;
}> {
  const triggers: Array<{
    position: Position;
    trigger: 'takeProfit' | 'stopLoss' | 'timeLimit';
    currentPrice: number;
  }> = [];

  const now = new Date();

  for (const position of portfolio.positions) {
    // Stop loss
    if (position.currentPrice <= position.exitCriteria.stopLoss) {
      triggers.push({
        position,
        trigger: 'stopLoss',
        currentPrice: position.currentPrice
      });
    }
    // Take profit
    else if (position.currentPrice >= position.exitCriteria.takeProfit) {
      triggers.push({
        position,
        trigger: 'takeProfit',
        currentPrice: position.currentPrice
      });
    }
    // Time limit
    else if (position.exitCriteria.timeLimit && new Date(position.exitCriteria.timeLimit) <= now) {
      triggers.push({
        position,
        trigger: 'timeLimit',
        currentPrice: position.currentPrice
      });
    }
  }

  return triggers;
}

// ============================================================================
// Helper Functions
// ============================================================================

function updatePortfolioMetrics(portfolio: Portfolio): void {
  const unrealizedPnL = portfolio.positions.reduce((sum, p) => sum + p.unrealizedPnL, 0);
  const totalReturn = portfolio.metrics.realizedPnL + unrealizedPnL;

  portfolio.metrics.unrealizedPnL = unrealizedPnL;
  portfolio.metrics.totalReturn = totalReturn;
  portfolio.metrics.totalReturnPct = (totalReturn / portfolio.startingCapital) * 100;

  const totalTrades = portfolio.metrics.winCount + portfolio.metrics.lossCount;
  portfolio.metrics.winRate = totalTrades > 0 ? portfolio.metrics.winCount / totalTrades : 0;
}

/**
 * Get a summary of the portfolio for model context.
 * Returns a focused, readable summary instead of raw JSON.
 */
export function getPortfolioSummary(): string {
  const portfolio = loadPortfolio();

  const positionSummaries = portfolio.positions.map(p => {
    const pnlPct = ((p.currentPrice - p.entryPrice) / p.entryPrice * 100).toFixed(1);
    const pnlSign = p.unrealizedPnL >= 0 ? '+' : '';
    return `  - ${p.outcome || p.market}: ${(p.entryPrice * 100).toFixed(1)}¢ → ${(p.currentPrice * 100).toFixed(1)}¢ (${pnlSign}${pnlPct}%, ${pnlSign}$${p.unrealizedPnL.toFixed(2)})`;
  }).join('\n');

  return `
## Portfolio Summary
- Cash: $${portfolio.cash.toFixed(2)} / $${portfolio.startingCapital} (${(portfolio.cash / portfolio.startingCapital * 100).toFixed(0)}%)
- Positions: ${portfolio.positions.length}/${CONFIG.maxConcurrentPositions}
- Total Return: ${portfolio.metrics.totalReturn >= 0 ? '+' : ''}$${portfolio.metrics.totalReturn.toFixed(2)} (${portfolio.metrics.totalReturnPct >= 0 ? '+' : ''}${portfolio.metrics.totalReturnPct.toFixed(2)}%)
- Win Rate: ${(portfolio.metrics.winRate * 100).toFixed(0)}% (${portfolio.metrics.winCount}W/${portfolio.metrics.lossCount}L)

## Open Positions
${positionSummaries || '  (none)'}

## Constraints
- Max single market: ${CONFIG.maxSingleMarketPct * 100}%
- Max positions: ${CONFIG.maxConcurrentPositions}
- Cash reserve: ${CONFIG.minCashReservePct * 100}%
- Auto-approve: trades ≤ $${CONFIG.autoApproveLimit}
- Notify: trades ≤ $${CONFIG.notifyLimit}
- Require approval: trades > $${CONFIG.notifyLimit}
`.trim();
}

/**
 * Execute an approved trade (called by Telegram handler after CEO approval).
 */
export async function executeApprovedTrade(approvalId: string): Promise<TradeResult> {
  const approvals = JSON.parse(fs.readFileSync(APPROVALS_FILE, 'utf-8'));
  const approval = approvals.approvals.find((a: any) => a.id === approvalId);

  if (!approval) {
    return { success: false, error: `Approval ${approvalId} not found` };
  }

  if (approval.status !== 'approved') {
    return { success: false, error: `Approval ${approvalId} is not approved (status: ${approval.status})` };
  }

  // Extract trade params from approval context
  const params: TradeParams = approval.context;

  // Execute with auto tier (already approved)
  const portfolio = loadPortfolio();
  const validation = validateTrade(params, portfolio);

  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  const shares = Math.floor(params.amount / params.price);
  const actualCost = shares * params.price;
  const tradeId = `trade-${Date.now().toString(36)}`;

  const position: Position = {
    id: tradeId,
    market: params.marketQuestion || params.market,
    marketSlug: params.market,
    platform: 'Polymarket',
    direction: params.direction,
    outcome: params.outcome,
    entryPrice: params.price,
    shares,
    cost: actualCost,
    currentPrice: params.price,
    unrealizedPnL: 0,
    hypothesisId: params.hypothesisId,
    entryDate: new Date().toISOString(),
    exitCriteria: params.exitCriteria,
    rationale: params.rationale,
    tokenId: params.tokenId,
  };

  portfolio.cash -= actualCost;
  portfolio.positions.push(position);
  portfolio.tradeHistory.push({
    tradeId,
    type: 'ENTRY',
    timestamp: new Date().toISOString(),
    market: position.market,
    marketSlug: position.marketSlug,
    direction: position.direction,
    outcome: position.outcome,
    price: position.entryPrice,
    shares: position.shares,
    cost: position.cost,
    hypothesisId: position.hypothesisId,
    rationale: position.rationale,
    cashAfter: portfolio.cash,
  });

  updatePortfolioMetrics(portfolio);
  savePortfolio(portfolio);

  // Update approval status
  approval.status = 'executed';
  approval.executedAt = new Date().toISOString();
  approval.tradeId = tradeId;
  fs.writeFileSync(APPROVALS_FILE, JSON.stringify(approvals, null, 2));

  await sendMessage(
    `✅ *Approved Trade Executed*\n\n` +
    `${params.direction} ${params.outcome || params.market}\n` +
    `Shares: ${shares} @ ${(params.price * 100).toFixed(1)}¢\n` +
    `Cost: $${actualCost.toFixed(2)}\n\n` +
    `Cash remaining: $${portfolio.cash.toFixed(2)}`
  );

  return { success: true, tradeId, shares, cost: actualCost };
}
