/**
 * Hypothesis Auto-Tester (imp-011)
 *
 * Automated testing framework for trading hypotheses.
 * - Monitors hypotheses in "testing" status
 * - Checks entry conditions and executes paper trades
 * - Monitors exit conditions (TP/SL/time)
 * - Tracks results and updates hypothesis performance
 * - Auto-promotes/kills based on performance thresholds
 *
 * Usage: npx ts-node tools/pipelines/hypothesis-tester.ts
 * Output: JSON with actions taken
 */

import * as fs from 'fs';
import * as path from 'path';
import { sendAlert, alertTradeExecuted, alertHypothesisUpdate } from '../alerts/telegram-alerts';

const STATE_DIR = path.join(__dirname, '../../state');
const HYPOTHESES_FILE = path.join(STATE_DIR, 'trading/hypotheses.json');
const PORTFOLIO_FILE = path.join(STATE_DIR, 'trading/portfolio.json');
const ENGINE_STATUS_FILE = path.join(STATE_DIR, 'trading/engine-status.json');
const TESTER_STATE_FILE = path.join(STATE_DIR, 'trading/tester-state.json');

const CLOB_API = 'https://clob.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';

// Configuration
const CONFIG = {
  // Position sizing
  defaultPositionSize: 100, // $100 per hypothesis test
  maxPositionSize: 500,     // Never more than $500 per position
  maxOpenPositions: 5,      // Max concurrent test positions

  // Performance thresholds
  minSampleSize: 5,         // Min trades before judging hypothesis
  validateWinRate: 0.60,    // 60%+ win rate to validate
  invalidateWinRate: 0.35,  // <35% win rate to invalidate
  validateProfitFactor: 1.5,// Gross profit / gross loss ratio

  // Auto-close rules
  maxDaysInTest: 30,        // Auto-close after 30 days
  maxLossPerHypothesis: -200, // Auto-kill if down $200+

  // Confidence adjustments
  winConfidenceBoost: 0.05,
  lossConfidenceHit: 0.08,
  minConfidence: 0.20,      // Kill if below this
  maxConfidence: 0.90,      // Cap confidence
};

interface Hypothesis {
  id: string;
  statement: string;
  status: string;
  confidence: number;
  entryRules?: string;
  exitRules?: string;
  expectedWinRate?: number;
  expectedPayoff?: number;
  minSampleSize?: number;
  testStartedAt?: string;
  testEndedAt?: string;
  linkedMarket?: {
    slug: string;
    question: string;
    tokenId: string;
  };
  driftData?: {
    previousPrice: number;
    currentPrice: number;
    priceChangePct: number;
    signalStrength: string;
    detectedAt: string;
  };
  testResults?: {
    trades: number;
    wins: number;
    losses: number;
    totalPnL: number;
    actualWinRate: number;
    grossProfit: number;
    grossLoss: number;
    profitFactor: number;
    avgWin: number;
    avgLoss: number;
    positions: string[];
  };
  evidence: any[];
  conclusion: string | null;
  updatedAt: string;
}

interface Position {
  id: string;
  hypothesisId: string;
  market: string;
  marketSlug: string;
  tokenId: string;
  direction: 'YES' | 'NO';
  outcome: string;
  entryPrice: number;
  shares: number;
  cost: number;
  currentPrice: number;
  unrealizedPnL: number;
  entryDate: string;
  exitCriteria: {
    takeProfit: number;
    stopLoss: number;
    timeLimit: string;
  };
}

interface Portfolio {
  cash: number;
  startingCapital: number;
  positions: Position[];
  tradeHistory: any[];
  lastUpdated: string;
  metrics: any;
}

interface TesterState {
  lastRun: string;
  activeTests: {
    hypothesisId: string;
    positionId: string;
    enteredAt: string;
    entryPrice: number;
  }[];
  pendingEntries: {
    hypothesisId: string;
    market: string;
    tokenId: string;
    direction: 'YES' | 'NO';
    targetEntry: number;
    createdAt: string;
  }[];
  stats: {
    totalTestsRun: number;
    totalWins: number;
    totalLosses: number;
    totalPnL: number;
  };
}

interface PipelineOutput {
  runAt: string;
  hypothesesEvaluated: number;
  entriesExecuted: string[];
  exitsExecuted: string[];
  hypothesesPromoted: string[];
  hypothesesKilled: string[];
  confidenceUpdates: { id: string; old: number; new: number }[];
  alerts: string[];
  errors: string[];
}

function loadTesterState(): TesterState {
  try {
    return JSON.parse(fs.readFileSync(TESTER_STATE_FILE, 'utf-8'));
  } catch {
    return {
      lastRun: new Date(0).toISOString(),
      activeTests: [],
      pendingEntries: [],
      stats: { totalTestsRun: 0, totalWins: 0, totalLosses: 0, totalPnL: 0 }
    };
  }
}

function saveTesterState(state: TesterState): void {
  fs.writeFileSync(TESTER_STATE_FILE, JSON.stringify(state, null, 2));
}

async function fetchPrice(tokenId: string): Promise<number | null> {
  try {
    const [buyRes, sellRes] = await Promise.all([
      fetch(`${CLOB_API}/price?token_id=${tokenId}&side=buy`),
      fetch(`${CLOB_API}/price?token_id=${tokenId}&side=sell`)
    ]);

    if (!buyRes.ok || !sellRes.ok) return null;

    const buyData = await buyRes.json() as any;
    const sellData = await sellRes.json() as any;

    const bid = parseFloat(buyData.price) || 0;
    const ask = parseFloat(sellData.price) || 0;

    return (bid + ask) / 2 || bid || ask || null;
  } catch {
    return null;
  }
}

async function fetchMarketBySlug(slug: string): Promise<any | null> {
  try {
    const response = await fetch(`${GAMMA_API}/markets?slug=${slug}`);
    if (!response.ok) return null;
    const markets = await response.json() as any[];
    return markets[0] || null;
  } catch {
    return null;
  }
}

function canEnterNewPosition(portfolio: Portfolio, testerState: TesterState): boolean {
  // Check max positions
  const testPositions = portfolio.positions.filter(p =>
    testerState.activeTests.some(t => t.positionId === p.id)
  );

  if (testPositions.length >= CONFIG.maxOpenPositions) {
    return false;
  }

  // Check available cash
  if (portfolio.cash < CONFIG.defaultPositionSize) {
    return false;
  }

  return true;
}

function calculatePositionSize(hypothesis: Hypothesis, portfolio: Portfolio): number {
  // Base size
  let size = CONFIG.defaultPositionSize;

  // Scale by confidence
  if (hypothesis.confidence > 0.6) {
    size *= 1.5;
  } else if (hypothesis.confidence < 0.4) {
    size *= 0.5;
  }

  // Cap at max and available cash
  size = Math.min(size, CONFIG.maxPositionSize, portfolio.cash * 0.2);

  return Math.floor(size);
}

function calculateExitCriteria(hypothesis: Hypothesis, entryPrice: number): Position['exitCriteria'] {
  // Parse exit rules if present, otherwise use defaults
  let takeProfit = entryPrice * 2; // 2x by default
  let stopLoss = entryPrice * 0.5; // 50% loss

  // For drift signals, tighter stops
  if (hypothesis.driftData) {
    // Target: 50% of initial move continuation
    const movePct = Math.abs(hypothesis.driftData.priceChangePct);
    const targetMove = movePct * 0.5;

    if (hypothesis.driftData.priceChangePct > 0) {
      takeProfit = Math.min(0.95, entryPrice * (1 + targetMove));
      stopLoss = Math.max(0.02, hypothesis.driftData.previousPrice - 0.02);
    } else {
      takeProfit = Math.max(0.05, entryPrice * (1 - targetMove));
      stopLoss = Math.min(0.98, hypothesis.driftData.previousPrice + 0.02);
    }
  }

  // Parse explicit rules if present
  if (hypothesis.exitRules) {
    const tpMatch = hypothesis.exitRules.match(/[Tt]arget[:\s]+(\d+(?:\.\d+)?)[¢%]?/);
    const slMatch = hypothesis.exitRules.match(/[Ss]top[:\s]+(\d+(?:\.\d+)?)[¢%]?/);

    if (tpMatch) {
      const val = parseFloat(tpMatch[1]);
      takeProfit = val > 1 ? val / 100 : val; // Convert cents to decimal
    }
    if (slMatch) {
      const val = parseFloat(slMatch[1]);
      stopLoss = val > 1 ? val / 100 : val;
    }
  }

  // Time limit: 14 days for short-term, 30 for longer
  const daysToExpiry = hypothesis.driftData ? 7 : 14;
  const timeLimit = new Date(Date.now() + daysToExpiry * 24 * 60 * 60 * 1000).toISOString();

  return { takeProfit, stopLoss, timeLimit };
}

async function executeEntry(
  hypothesis: Hypothesis,
  portfolio: Portfolio,
  testerState: TesterState
): Promise<{ success: boolean; positionId?: string; error?: string }> {
  if (!hypothesis.linkedMarket?.tokenId) {
    return { success: false, error: 'No linked market with tokenId' };
  }

  const currentPrice = await fetchPrice(hypothesis.linkedMarket.tokenId);
  if (!currentPrice) {
    return { success: false, error: 'Could not fetch price' };
  }

  const positionSize = calculatePositionSize(hypothesis, portfolio);
  const shares = Math.floor(positionSize / currentPrice);
  const cost = shares * currentPrice;

  if (cost > portfolio.cash) {
    return { success: false, error: 'Insufficient cash' };
  }

  // Determine direction based on drift
  const direction: 'YES' | 'NO' = hypothesis.driftData?.priceChangePct
    ? (hypothesis.driftData.priceChangePct > 0 ? 'YES' : 'NO')
    : 'YES';

  const positionId = `test-${hypothesis.id}-${Date.now()}`;
  const exitCriteria = calculateExitCriteria(hypothesis, currentPrice);

  const position: Position = {
    id: positionId,
    hypothesisId: hypothesis.id,
    market: hypothesis.linkedMarket.question || hypothesis.linkedMarket.slug,
    marketSlug: hypothesis.linkedMarket.slug,
    tokenId: hypothesis.linkedMarket.tokenId,
    direction,
    outcome: direction,
    entryPrice: currentPrice,
    shares,
    cost,
    currentPrice,
    unrealizedPnL: 0,
    entryDate: new Date().toISOString(),
    exitCriteria
  };

  // Update portfolio
  portfolio.cash -= cost;
  portfolio.positions.push(position as any);
  portfolio.tradeHistory.push({
    id: positionId,
    type: 'ENTRY',
    timestamp: new Date().toISOString(),
    hypothesisId: hypothesis.id,
    market: position.market,
    marketSlug: position.marketSlug,
    direction,
    price: currentPrice,
    shares,
    cost,
    cashAfter: portfolio.cash,
    reason: `Auto-test entry for ${hypothesis.id}`
  });
  portfolio.lastUpdated = new Date().toISOString();

  // Track in tester state
  testerState.activeTests.push({
    hypothesisId: hypothesis.id,
    positionId,
    enteredAt: new Date().toISOString(),
    entryPrice: currentPrice
  });

  return { success: true, positionId };
}

async function executeExit(
  position: Position,
  portfolio: Portfolio,
  testerState: TesterState,
  reason: 'take_profit' | 'stop_loss' | 'time_limit' | 'manual'
): Promise<{ success: boolean; pnl: number }> {
  const currentPrice = await fetchPrice(position.tokenId);
  if (!currentPrice) {
    return { success: false, pnl: 0 };
  }

  const exitValue = position.shares * currentPrice;
  const pnl = exitValue - position.cost;

  // Update portfolio
  portfolio.cash += exitValue;
  portfolio.positions = portfolio.positions.filter(p => p.id !== position.id);
  portfolio.tradeHistory.push({
    id: position.id,
    type: 'EXIT',
    timestamp: new Date().toISOString(),
    hypothesisId: position.hypothesisId,
    market: position.market,
    direction: position.direction,
    entryPrice: position.entryPrice,
    exitPrice: currentPrice,
    shares: position.shares,
    pnl,
    exitReason: reason,
    cashAfter: portfolio.cash
  });

  // Update metrics
  portfolio.metrics.realizedPnL = (portfolio.metrics.realizedPnL || 0) + pnl;
  if (pnl > 0) {
    portfolio.metrics.winCount = (portfolio.metrics.winCount || 0) + 1;
  } else {
    portfolio.metrics.lossCount = (portfolio.metrics.lossCount || 0) + 1;
  }
  portfolio.lastUpdated = new Date().toISOString();

  // Remove from active tests
  testerState.activeTests = testerState.activeTests.filter(t => t.positionId !== position.id);
  testerState.stats.totalTestsRun++;
  testerState.stats.totalPnL += pnl;
  if (pnl > 0) {
    testerState.stats.totalWins++;
  } else {
    testerState.stats.totalLosses++;
  }

  return { success: true, pnl };
}

function updateHypothesisResults(
  hypothesis: Hypothesis,
  pnl: number,
  isWin: boolean
): void {
  if (!hypothesis.testResults) {
    hypothesis.testResults = {
      trades: 0,
      wins: 0,
      losses: 0,
      totalPnL: 0,
      actualWinRate: 0,
      grossProfit: 0,
      grossLoss: 0,
      profitFactor: 0,
      avgWin: 0,
      avgLoss: 0,
      positions: []
    };
  }

  const r = hypothesis.testResults;
  r.trades++;
  r.totalPnL += pnl;

  if (isWin) {
    r.wins++;
    r.grossProfit += pnl;
  } else {
    r.losses++;
    r.grossLoss += Math.abs(pnl);
  }

  r.actualWinRate = r.trades > 0 ? r.wins / r.trades : 0;
  r.profitFactor = r.grossLoss > 0 ? r.grossProfit / r.grossLoss : r.grossProfit > 0 ? Infinity : 0;
  r.avgWin = r.wins > 0 ? r.grossProfit / r.wins : 0;
  r.avgLoss = r.losses > 0 ? r.grossLoss / r.losses : 0;

  // Adjust confidence
  if (isWin) {
    hypothesis.confidence = Math.min(CONFIG.maxConfidence, hypothesis.confidence + CONFIG.winConfidenceBoost);
  } else {
    hypothesis.confidence = Math.max(CONFIG.minConfidence, hypothesis.confidence - CONFIG.lossConfidenceHit);
  }

  hypothesis.updatedAt = new Date().toISOString();
}

function evaluateHypothesisStatus(hypothesis: Hypothesis): 'validated' | 'invalidated' | 'continue' {
  const r = hypothesis.testResults;
  if (!r || r.trades < CONFIG.minSampleSize) {
    return 'continue';
  }

  // Check for validation
  if (r.actualWinRate >= CONFIG.validateWinRate && r.profitFactor >= CONFIG.validateProfitFactor) {
    return 'validated';
  }

  // Check for invalidation
  if (r.actualWinRate < CONFIG.invalidateWinRate) {
    return 'invalidated';
  }

  // Check confidence floor
  if (hypothesis.confidence <= CONFIG.minConfidence) {
    return 'invalidated';
  }

  // Check max loss
  if (r.totalPnL <= CONFIG.maxLossPerHypothesis) {
    return 'invalidated';
  }

  return 'continue';
}

function checkExitConditions(position: Position, currentPrice: number): 'take_profit' | 'stop_loss' | 'time_limit' | null {
  // For YES positions, higher price = profit
  // For NO positions, lower price = profit (but we're tracking YES token price)

  if (position.direction === 'YES') {
    if (currentPrice >= position.exitCriteria.takeProfit) return 'take_profit';
    if (currentPrice <= position.exitCriteria.stopLoss) return 'stop_loss';
  } else {
    // NO position: we profit if price goes down
    if (currentPrice <= position.exitCriteria.takeProfit) return 'take_profit';
    if (currentPrice >= position.exitCriteria.stopLoss) return 'stop_loss';
  }

  // Time limit
  if (new Date() >= new Date(position.exitCriteria.timeLimit)) {
    return 'time_limit';
  }

  return null;
}

function shouldEnterHypothesis(hypothesis: Hypothesis, testerState: TesterState): boolean {
  // Must be in testing status
  if (hypothesis.status !== 'testing') return false;

  // Must have linked market
  if (!hypothesis.linkedMarket?.tokenId) return false;

  // Must not already have active position
  if (testerState.activeTests.some(t => t.hypothesisId === hypothesis.id)) return false;

  // Must have reasonable confidence
  if (hypothesis.confidence < 0.30) return false;

  // Check if from auto-generated pipeline (drift detector, closing scanner)
  // These are designed for auto-entry
  if (hypothesis.id.startsWith('hyp-drift-')) return true;

  // For manually created hypotheses, only enter if testStartedAt is recent
  // and testResults is empty (first trade)
  if (hypothesis.testStartedAt) {
    const daysSinceStart = (Date.now() - new Date(hypothesis.testStartedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceStart < 1 && (!hypothesis.testResults || hypothesis.testResults.trades === 0)) {
      return true;
    }
  }

  return false;
}

async function runPipeline(): Promise<PipelineOutput> {
  const output: PipelineOutput = {
    runAt: new Date().toISOString(),
    hypothesesEvaluated: 0,
    entriesExecuted: [],
    exitsExecuted: [],
    hypothesesPromoted: [],
    hypothesesKilled: [],
    confidenceUpdates: [],
    alerts: [],
    errors: []
  };

  console.error('Starting hypothesis-tester pipeline...');

  // Load state
  let hypotheses: { hypotheses: Hypothesis[] };
  let portfolio: Portfolio;
  let testerState: TesterState;

  try {
    hypotheses = JSON.parse(fs.readFileSync(HYPOTHESES_FILE, 'utf-8'));
    portfolio = JSON.parse(fs.readFileSync(PORTFOLIO_FILE, 'utf-8'));
    testerState = loadTesterState();
  } catch (error: any) {
    output.errors.push(`Failed to load state: ${error.message}`);
    return output;
  }

  // Phase 1: Check exits for active positions
  console.error(`Checking ${testerState.activeTests.length} active test positions...`);

  for (const activeTest of [...testerState.activeTests]) {
    const position = portfolio.positions.find(p => p.id === activeTest.positionId) as Position | undefined;
    if (!position) {
      // Position was closed externally, clean up
      testerState.activeTests = testerState.activeTests.filter(t => t.positionId !== activeTest.positionId);
      continue;
    }

    const currentPrice = await fetchPrice(position.tokenId);
    if (!currentPrice) {
      output.errors.push(`Could not fetch price for ${position.id}`);
      continue;
    }

    // Update position price
    position.currentPrice = currentPrice;
    position.unrealizedPnL = (currentPrice - position.entryPrice) * position.shares;

    // Check exit conditions
    const exitReason = checkExitConditions(position, currentPrice);

    if (exitReason) {
      console.error(`Exit triggered for ${position.id}: ${exitReason}`);

      const exitResult = await executeExit(position, portfolio, testerState, exitReason);

      if (exitResult.success) {
        output.exitsExecuted.push(position.id);

        // Update hypothesis results
        const hypothesis = hypotheses.hypotheses.find(h => h.id === position.hypothesisId);
        if (hypothesis) {
          const oldConfidence = hypothesis.confidence;
          updateHypothesisResults(hypothesis, exitResult.pnl, exitResult.pnl > 0);

          output.confidenceUpdates.push({
            id: hypothesis.id,
            old: oldConfidence,
            new: hypothesis.confidence
          });

          // Evaluate if hypothesis should be promoted/killed
          const evaluation = evaluateHypothesisStatus(hypothesis);

          if (evaluation === 'validated') {
            hypothesis.status = 'validated';
            hypothesis.conclusion = `Validated after ${hypothesis.testResults?.trades} trades. Win rate: ${(hypothesis.testResults?.actualWinRate || 0 * 100).toFixed(0)}%, P&L: $${hypothesis.testResults?.totalPnL.toFixed(2)}`;
            hypothesis.testEndedAt = new Date().toISOString();
            output.hypothesesPromoted.push(hypothesis.id);

            await alertHypothesisUpdate(
              hypothesis.id,
              hypothesis.statement,
              'validated',
              hypothesis.confidence,
              hypothesis.conclusion
            );
          } else if (evaluation === 'invalidated') {
            hypothesis.status = 'invalidated';
            hypothesis.conclusion = `Invalidated after ${hypothesis.testResults?.trades} trades. Win rate: ${((hypothesis.testResults?.actualWinRate || 0) * 100).toFixed(0)}%, P&L: $${hypothesis.testResults?.totalPnL.toFixed(2)}`;
            hypothesis.testEndedAt = new Date().toISOString();
            output.hypothesesKilled.push(hypothesis.id);

            await alertHypothesisUpdate(
              hypothesis.id,
              hypothesis.statement,
              'invalidated',
              hypothesis.confidence,
              hypothesis.conclusion
            );
          }
        }

        // Send trade alert
        await alertTradeExecuted(
          'EXIT',
          position.market,
          position.outcome,
          position.direction,
          currentPrice,
          position.shares,
          Math.abs(exitResult.pnl),
          `${exitReason}: ${exitResult.pnl >= 0 ? '+' : ''}$${exitResult.pnl.toFixed(2)}`
        );
      }
    }
  }

  // Phase 2: Check for new entries
  const testingHypotheses = hypotheses.hypotheses.filter(h => h.status === 'testing');
  output.hypothesesEvaluated = testingHypotheses.length;
  console.error(`Evaluating ${testingHypotheses.length} testing hypotheses for entry...`);

  for (const hypothesis of testingHypotheses) {
    if (!canEnterNewPosition(portfolio, testerState)) {
      console.error('Max positions reached or insufficient cash, skipping entries');
      break;
    }

    if (!shouldEnterHypothesis(hypothesis, testerState)) {
      continue;
    }

    console.error(`Attempting entry for ${hypothesis.id}...`);

    const entryResult = await executeEntry(hypothesis, portfolio, testerState);

    if (entryResult.success && entryResult.positionId) {
      output.entriesExecuted.push(entryResult.positionId);

      const position = portfolio.positions.find(p => p.id === entryResult.positionId) as Position;

      await alertTradeExecuted(
        'ENTRY',
        position.market,
        position.outcome,
        position.direction,
        position.entryPrice,
        position.shares,
        position.cost,
        `Auto-test: ${hypothesis.id}`
      );

      console.error(`Entered position ${entryResult.positionId}`);
    } else if (entryResult.error) {
      console.error(`Entry failed for ${hypothesis.id}: ${entryResult.error}`);
    }
  }

  // Phase 3: Check hypotheses that have been testing too long without activity
  const now = Date.now();
  for (const hypothesis of testingHypotheses) {
    if (hypothesis.testStartedAt) {
      const daysTesting = (now - new Date(hypothesis.testStartedAt).getTime()) / (1000 * 60 * 60 * 24);

      if (daysTesting > CONFIG.maxDaysInTest) {
        const hasActivePosition = testerState.activeTests.some(t => t.hypothesisId === hypothesis.id);

        if (!hasActivePosition) {
          // Hypothesis has been stuck in testing with no activity
          hypothesis.status = 'inconclusive';
          hypothesis.conclusion = `Marked inconclusive after ${Math.floor(daysTesting)} days with insufficient data`;
          hypothesis.testEndedAt = new Date().toISOString();

          output.hypothesesKilled.push(hypothesis.id);
          console.error(`Marked ${hypothesis.id} as inconclusive (stale)`);
        }
      }
    }
  }

  // Save all state
  fs.writeFileSync(HYPOTHESES_FILE, JSON.stringify(hypotheses, null, 2));
  fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(portfolio, null, 2));
  saveTesterState(testerState);

  // Update engine status
  try {
    const engineStatus = JSON.parse(fs.readFileSync(ENGINE_STATUS_FILE, 'utf-8'));
    engineStatus.lastEvaluated = new Date().toISOString();
    engineStatus.metrics.hypothesesTestedThisWeek += output.entriesExecuted.length;
    engineStatus.metrics.hypothesesValidatedThisWeek += output.hypothesesPromoted.length;
    engineStatus.metrics.hypothesesInvalidatedThisWeek += output.hypothesesKilled.length;
    fs.writeFileSync(ENGINE_STATUS_FILE, JSON.stringify(engineStatus, null, 2));
  } catch (error: any) {
    output.errors.push(`Failed to update engine status: ${error.message}`);
  }

  testerState.lastRun = output.runAt;
  saveTesterState(testerState);

  // Summary alert if significant activity
  if (output.entriesExecuted.length > 0 || output.exitsExecuted.length > 0 ||
      output.hypothesesPromoted.length > 0 || output.hypothesesKilled.length > 0) {
    const summary = [
      output.entriesExecuted.length > 0 ? `${output.entriesExecuted.length} entries` : '',
      output.exitsExecuted.length > 0 ? `${output.exitsExecuted.length} exits` : '',
      output.hypothesesPromoted.length > 0 ? `${output.hypothesesPromoted.length} validated` : '',
      output.hypothesesKilled.length > 0 ? `${output.hypothesesKilled.length} killed` : ''
    ].filter(Boolean).join(', ');

    await sendAlert({
      type: 'system_alert',
      severity: 'info',
      title: 'Hypothesis Tester Run',
      message: summary
    });
  }

  return output;
}

// CLI interface
if (require.main === module) {
  runPipeline()
    .then(output => {
      console.log(JSON.stringify(output, null, 2));
      process.exit(output.errors.length > 0 && output.entriesExecuted.length === 0 && output.exitsExecuted.length === 0 ? 1 : 0);
    })
    .catch(error => {
      console.error(`Pipeline failed: ${error.message}`);
      process.exit(1);
    });
}

export { runPipeline };
export type { TesterState, Hypothesis };
