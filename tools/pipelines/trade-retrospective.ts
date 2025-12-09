/**
 * Trade Retrospective Pipeline
 *
 * Runs automatically after trade resolution (win or loss) to:
 * 1. Analyze what worked/failed
 * 2. Update hypothesis confidence based on outcome
 * 3. Add learning to learnings.json
 * 4. Send summary to Telegram
 *
 * Usage:
 *   npx ts-node tools/pipelines/trade-retrospective.ts <tradeId>    # Analyze specific trade
 *   npx ts-node tools/pipelines/trade-retrospective.ts --recent     # Analyze all recent resolved trades
 */

import * as fs from 'fs';
import * as path from 'path';
import { sendMessage } from '../telegram/bot';

const STATE_DIR = path.join(__dirname, '../../state');
const PORTFOLIO_FILE = path.join(STATE_DIR, 'trading/portfolio.json');
const HYPOTHESES_FILE = path.join(STATE_DIR, 'trading/hypotheses.json');
const LEARNINGS_FILE = path.join(STATE_DIR, 'trading/learnings.json');
const RETROSPECTIVES_FILE = path.join(STATE_DIR, 'trading/retrospectives.json');

interface Trade {
  id: string;
  market: string;
  direction: string;
  entryPrice: number;
  exitPrice: number;
  shares: number;
  cost: number;
  proceeds: number;
  pnl: number;
  pnlPct: number;
  hypothesisId: string;
  rationale: string;
  exitReason: string;
  entryDate: string;
  exitDate: string;
  won: boolean;
}

interface Retrospective {
  tradeId: string;
  hypothesisId: string;
  outcome: 'win' | 'loss';
  pnl: number;
  pnlPct: number;
  analysis: {
    entryQuality: string;
    exitQuality: string;
    hypothesisValid: boolean;
    keyLearning: string;
    improvementSuggestion: string;
  };
  confidenceUpdate: {
    before: number;
    after: number;
    reason: string;
  };
  createdAt: string;
}

interface Portfolio {
  tradeHistory: Trade[];
  [key: string]: any;
}

interface Hypothesis {
  id: string;
  statement: string;
  confidence: number;
  testResults?: {
    trades: number;
    wins: number;
    losses: number;
    totalPnL: number;
    actualWinRate: number;
  };
  [key: string]: any;
}

interface LearningsFile {
  insights: Array<{
    id: string;
    category: string;
    title: string;
    content: string;
    source: string;
    actionable: boolean;
    appliedTo: string[];
    createdAt: string;
  }>;
}

function loadPortfolio(): Portfolio {
  return JSON.parse(fs.readFileSync(PORTFOLIO_FILE, 'utf-8'));
}

function loadHypotheses(): Hypothesis[] {
  const data = JSON.parse(fs.readFileSync(HYPOTHESES_FILE, 'utf-8'));
  return data.hypotheses || [];
}

function saveHypotheses(hypotheses: Hypothesis[]): void {
  fs.writeFileSync(HYPOTHESES_FILE, JSON.stringify({ hypotheses }, null, 2));
}

function loadLearnings(): LearningsFile {
  try {
    return JSON.parse(fs.readFileSync(LEARNINGS_FILE, 'utf-8'));
  } catch {
    return { insights: [] };
  }
}

function saveLearnings(data: LearningsFile): void {
  fs.writeFileSync(LEARNINGS_FILE, JSON.stringify(data, null, 2));
}

function loadRetrospectives(): Retrospective[] {
  try {
    const data = JSON.parse(fs.readFileSync(RETROSPECTIVES_FILE, 'utf-8'));
    return data.retrospectives || [];
  } catch {
    return [];
  }
}

function saveRetrospectives(retrospectives: Retrospective[]): void {
  fs.writeFileSync(RETROSPECTIVES_FILE, JSON.stringify({ retrospectives }, null, 2));
}

/**
 * Analyze a completed trade and generate retrospective
 */
function analyzeTradeOutcome(trade: Trade): Retrospective['analysis'] {
  const pnlPct = trade.pnlPct;
  const won = trade.won;

  // Entry quality assessment
  let entryQuality: string;
  if (won && pnlPct > 20) {
    entryQuality = 'Excellent entry - significant profit captured';
  } else if (won && pnlPct > 5) {
    entryQuality = 'Good entry - profitable outcome';
  } else if (won) {
    entryQuality = 'Marginal entry - small profit';
  } else if (pnlPct > -10) {
    entryQuality = 'Acceptable entry - minor loss, thesis may still be valid';
  } else if (pnlPct > -25) {
    entryQuality = 'Poor entry - significant loss, review timing';
  } else {
    entryQuality = 'Bad entry - major loss, hypothesis likely flawed';
  }

  // Exit quality assessment
  let exitQuality: string;
  if (trade.exitReason.includes('take profit') || trade.exitReason.includes('Target')) {
    exitQuality = 'Good exit - hit take profit target';
  } else if (trade.exitReason.includes('stop loss') || trade.exitReason.includes('Stop')) {
    exitQuality = 'Disciplined exit - stop loss triggered';
  } else if (trade.exitReason.includes('time') || trade.exitReason.includes('expir')) {
    exitQuality = 'Time-based exit - position reached deadline';
  } else if (trade.exitReason.includes('resolution') || trade.exitReason.includes('resolved')) {
    exitQuality = 'Market resolved - natural conclusion';
  } else {
    exitQuality = 'Manual exit - discretionary decision';
  }

  // Hypothesis validity check
  const hypothesisValid = won || pnlPct > -15; // Still valid if small loss

  // Key learning extraction
  let keyLearning: string;
  if (won && pnlPct > 15) {
    keyLearning = `High-conviction trade validated: ${trade.rationale.slice(0, 100)}`;
  } else if (won) {
    keyLearning = `Trade profitable but modest - consider larger position sizing on similar setups`;
  } else if (!won && pnlPct > -10) {
    keyLearning = `Small loss - hypothesis not invalidated, may need more data`;
  } else if (!won) {
    keyLearning = `Significant loss - review hypothesis assumptions: ${trade.rationale.slice(0, 80)}`;
  } else {
    keyLearning = 'Trade outcome recorded for pattern analysis';
  }

  // Improvement suggestion
  let improvementSuggestion: string;
  if (!won && pnlPct < -20) {
    improvementSuggestion = 'Consider tighter stop losses or smaller position sizes';
  } else if (won && pnlPct < 10) {
    improvementSuggestion = 'Profitable but below target - review take profit levels';
  } else if (won && pnlPct > 30) {
    improvementSuggestion = 'Strong win - look for similar setups to scale';
  } else {
    improvementSuggestion = 'Continue tracking this strategy pattern';
  }

  return {
    entryQuality,
    exitQuality,
    hypothesisValid,
    keyLearning,
    improvementSuggestion,
  };
}

/**
 * Calculate confidence update based on trade outcome
 */
function calculateConfidenceUpdate(
  hypothesis: Hypothesis,
  trade: Trade
): { delta: number; reason: string } {
  const won = trade.won;
  const pnlPct = trade.pnlPct;

  // Base confidence change
  let delta: number;
  let reason: string;

  if (won && pnlPct > 20) {
    delta = 0.08;
    reason = 'Strong win (+20%+) - high confidence boost';
  } else if (won && pnlPct > 5) {
    delta = 0.05;
    reason = 'Solid win - moderate confidence boost';
  } else if (won) {
    delta = 0.02;
    reason = 'Small win - minor confidence boost';
  } else if (pnlPct > -10) {
    delta = -0.02;
    reason = 'Small loss - minor confidence reduction';
  } else if (pnlPct > -25) {
    delta = -0.06;
    reason = 'Significant loss - moderate confidence reduction';
  } else {
    delta = -0.10;
    reason = 'Major loss - substantial confidence reduction';
  }

  return { delta, reason };
}

/**
 * Run retrospective analysis on a trade
 */
async function runRetrospective(tradeId: string): Promise<Retrospective | null> {
  const portfolio = loadPortfolio();
  const trade = portfolio.tradeHistory.find((t: Trade) => t.id === tradeId);

  if (!trade) {
    console.error(`Trade ${tradeId} not found in history`);
    return null;
  }

  if (!trade.exitDate || !trade.exitPrice) {
    console.error(`Trade ${tradeId} not yet resolved`);
    return null;
  }

  // Check if already processed
  const existing = loadRetrospectives();
  if (existing.find(r => r.tradeId === tradeId)) {
    console.log(`Trade ${tradeId} already has retrospective`);
    return null;
  }

  // Load hypothesis
  const hypotheses = loadHypotheses();
  const hypothesis = hypotheses.find(h => h.id === trade.hypothesisId);

  if (!hypothesis) {
    console.error(`Hypothesis ${trade.hypothesisId} not found`);
    return null;
  }

  // Analyze the trade
  const analysis = analyzeTradeOutcome(trade);
  const confidenceUpdate = calculateConfidenceUpdate(hypothesis, trade);

  // Create retrospective
  const retrospective: Retrospective = {
    tradeId: trade.id,
    hypothesisId: trade.hypothesisId,
    outcome: trade.won ? 'win' : 'loss',
    pnl: trade.pnl,
    pnlPct: trade.pnlPct,
    analysis,
    confidenceUpdate: {
      before: hypothesis.confidence,
      after: Math.max(0, Math.min(1, hypothesis.confidence + confidenceUpdate.delta)),
      reason: confidenceUpdate.reason,
    },
    createdAt: new Date().toISOString(),
  };

  // Update hypothesis confidence
  const prevConfidence = hypothesis.confidence;
  hypothesis.confidence = retrospective.confidenceUpdate.after;

  // Update hypothesis test results
  if (!hypothesis.testResults) {
    hypothesis.testResults = {
      trades: 0,
      wins: 0,
      losses: 0,
      totalPnL: 0,
      actualWinRate: 0,
    };
  }
  hypothesis.testResults.trades += 1;
  if (trade.won) {
    hypothesis.testResults.wins += 1;
  } else {
    hypothesis.testResults.losses += 1;
  }
  hypothesis.testResults.totalPnL += trade.pnl;
  hypothesis.testResults.actualWinRate =
    hypothesis.testResults.wins / hypothesis.testResults.trades;

  // Save updated hypotheses
  saveHypotheses(hypotheses);

  // Add learning
  const learnings = loadLearnings();
  const learning = {
    id: `learn-${Date.now().toString(36)}`,
    category: 'trade-outcome',
    title: `Trade ${trade.won ? 'Win' : 'Loss'}: ${trade.market}`,
    content: `
${trade.won ? '✅ WIN' : '❌ LOSS'}: ${trade.market} (${trade.direction})
P&L: $${trade.pnl.toFixed(2)} (${trade.pnlPct >= 0 ? '+' : ''}${trade.pnlPct.toFixed(1)}%)

Entry: ${(trade.entryPrice * 100).toFixed(1)}¢ → Exit: ${(trade.exitPrice * 100).toFixed(1)}¢
Reason: ${trade.exitReason}

**Analysis:**
- Entry: ${analysis.entryQuality}
- Exit: ${analysis.exitQuality}
- Hypothesis valid: ${analysis.hypothesisValid ? 'Yes' : 'No'}

**Key Learning:** ${analysis.keyLearning}

**Improvement:** ${analysis.improvementSuggestion}

**Confidence Update:** ${(prevConfidence * 100).toFixed(0)}% → ${(hypothesis.confidence * 100).toFixed(0)}% (${confidenceUpdate.reason})
    `.trim(),
    source: `Trade retrospective: ${trade.id}`,
    actionable: !trade.won && trade.pnlPct < -15,
    appliedTo: [trade.hypothesisId],
    createdAt: new Date().toISOString(),
  };
  learnings.insights.push(learning);
  saveLearnings(learnings);

  // Save retrospective
  existing.push(retrospective);
  saveRetrospectives(existing);

  // Send Telegram notification
  const emoji = trade.won ? '✅' : '❌';
  const message = `
${emoji} *Trade Retrospective*

*Market:* ${trade.market}
*Outcome:* ${trade.won ? 'WIN' : 'LOSS'}
*P&L:* $${trade.pnl.toFixed(2)} (${trade.pnlPct >= 0 ? '+' : ''}${trade.pnlPct.toFixed(1)}%)

*Analysis:*
• ${analysis.entryQuality}
• ${analysis.exitQuality}

*Key Learning:*
${analysis.keyLearning.slice(0, 150)}

*Confidence:* ${(prevConfidence * 100).toFixed(0)}% → ${(hypothesis.confidence * 100).toFixed(0)}%
  `.trim();

  try {
    await sendMessage(message);
  } catch (error) {
    console.error('Failed to send Telegram notification:', error);
  }

  console.log(`Retrospective completed for trade ${tradeId}`);
  return retrospective;
}

/**
 * Process all recent resolved trades without retrospectives
 */
async function processRecentTrades(): Promise<number> {
  const portfolio = loadPortfolio();
  const existing = loadRetrospectives();
  const processedIds = new Set(existing.map(r => r.tradeId));

  // Find resolved trades without retrospectives
  const unprocessed = portfolio.tradeHistory.filter(
    (t: Trade) => t.exitDate && t.exitPrice && !processedIds.has(t.id)
  );

  console.log(`Found ${unprocessed.length} trades to process`);

  let processed = 0;
  for (const trade of unprocessed) {
    const result = await runRetrospective(trade.id);
    if (result) {
      processed++;
    }
  }

  return processed;
}

// Main execution
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--recent') || args.length === 0) {
    const processed = await processRecentTrades();
    console.log(`Processed ${processed} retrospectives`);
  } else if (args[0]) {
    const result = await runRetrospective(args[0]);
    if (result) {
      console.log('Retrospective:', JSON.stringify(result, null, 2));
    }
  } else {
    console.log('Usage:');
    console.log('  npx ts-node trade-retrospective.ts <tradeId>');
    console.log('  npx ts-node trade-retrospective.ts --recent');
  }
}

// Export for use as module
export { runRetrospective, processRecentTrades, analyzeTradeOutcome };

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}
