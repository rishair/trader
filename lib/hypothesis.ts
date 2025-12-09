/**
 * Hypothesis State Machine
 *
 * Manages hypothesis lifecycle transitions and evidence tracking.
 * Code enforces valid transitions - models don't need to remember rules.
 *
 * State machine:
 *   proposed → testing → validated
 *                    ↓
 *              invalidated
 *   (any) → blocked (awaiting capability)
 */

import * as fs from 'fs';
import * as path from 'path';
import { sendMessage } from '../tools/telegram/bot';

const STATE_DIR = path.join(__dirname, '..', 'state');
const HYPOTHESES_FILE = path.join(STATE_DIR, 'trading/hypotheses.json');
const LEARNINGS_FILE = path.join(STATE_DIR, 'trading/learnings.json');
const HANDOFFS_FILE = path.join(STATE_DIR, 'orchestrator/handoffs.json');

// ============================================================================
// Types
// ============================================================================

export type HypothesisStatus =
  | 'proposed'      // Initial idea, not yet tested
  | 'testing'       // Actively gathering evidence
  | 'validated'     // Evidence supports hypothesis
  | 'invalidated'   // Evidence contradicts hypothesis
  | 'blocked';      // Waiting for capability

export interface Evidence {
  date: string;
  observation: string;
  supports: boolean | null;  // null = neutral/inconclusive
  confidenceImpact: number;  // -1 to +1
}

export interface TestResults {
  trades: number;
  wins: number;
  losses: number;
  totalPnL: number;
  actualWinRate: number;
}

export interface BacktestResults {
  runDate: string;
  marketType: string;
  sampleSize: number;
  winRate: number;
  avgReturn: number;
  sharpeRatio?: number;
  maxDrawdown?: number;
  notes?: string;
}

export interface Hypothesis {
  id: string;
  statement: string;
  rationale: string;
  source?: string;
  testMethod: string;
  entryRules?: string;
  exitRules?: string;
  expectedWinRate?: number;
  expectedPayoff?: number;
  minSampleSize?: number;
  status: HypothesisStatus;
  confidence: number;          // 0-1
  evidence: Evidence[];
  testResults?: TestResults;
  backtestResults?: BacktestResults;  // Historical backtest validation
  conclusion?: string;
  createdAt: string;
  updatedAt: string;
  testStartedAt?: string;
  testEndedAt?: string;
  linkedTrade?: string;
  linkedStrategy?: string;
  blockedReason?: string;
  blockedHandoffId?: string;
}

export interface TransitionResult {
  success: boolean;
  error?: string;
  hypothesis?: Hypothesis;
}

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  // Validation thresholds
  validationConfidence: 0.55,      // Confidence needed to validate
  invalidationConfidence: 0.35,    // Below this, should invalidate
  validationWinRate: 0.50,         // Win rate needed to validate
  invalidationWinRate: 0.40,       // Below this after min samples, invalidate

  // Testing requirements
  defaultMinSampleSize: 5,         // Minimum trades to validate

  // Auto-transition triggers
  autoInvalidateConfidence: 0.25,  // Auto-invalidate below this
  autoValidateConfidence: 0.75,    // Auto-validate above this (with other criteria)
};

// ============================================================================
// State Machine Transitions
// ============================================================================

interface TransitionRule {
  from: HypothesisStatus[];
  to: HypothesisStatus;
  validate: (h: Hypothesis) => string | null;  // Returns error or null if valid
}

const TRANSITIONS: TransitionRule[] = [
  {
    from: ['proposed'],
    to: 'testing',
    validate: (h) => {
      if (!h.testMethod) return 'testMethod is required to start testing';
      if (!h.entryRules && !h.testMethod.includes('entry')) {
        return 'entryRules or entry criteria in testMethod required';
      }
      return null;
    },
  },
  {
    from: ['testing'],
    to: 'validated',
    validate: (h) => {
      if (h.confidence < CONFIG.validationConfidence) {
        return `Confidence ${(h.confidence * 100).toFixed(0)}% below ${CONFIG.validationConfidence * 100}% threshold`;
      }
      const minSamples = h.minSampleSize || CONFIG.defaultMinSampleSize;
      if (h.testResults && h.testResults.trades < minSamples) {
        return `Only ${h.testResults.trades} trades, need ${minSamples} minimum`;
      }
      if (h.testResults && h.testResults.actualWinRate < CONFIG.validationWinRate) {
        return `Win rate ${(h.testResults.actualWinRate * 100).toFixed(0)}% below ${CONFIG.validationWinRate * 100}% threshold`;
      }
      return null;
    },
  },
  {
    from: ['proposed', 'testing'],
    to: 'invalidated',
    validate: (h) => {
      // Always allow invalidation with low confidence
      if (h.confidence < CONFIG.invalidationConfidence) return null;
      // Or with enough trades and poor performance
      if (h.testResults && h.testResults.trades >= (h.minSampleSize || CONFIG.defaultMinSampleSize)) {
        if (h.testResults.actualWinRate < CONFIG.invalidationWinRate) return null;
      }
      // Otherwise require explicit reason (will be in conclusion)
      return null;  // Allow manual invalidation
    },
  },
  {
    from: ['proposed', 'testing'],
    to: 'blocked',
    validate: (h) => {
      // Blocked requires a reason
      return null;  // Reason will be set via blockedReason field
    },
  },
  {
    from: ['blocked'],
    to: 'proposed',
    validate: () => null,  // Can always unblock back to proposed
  },
  {
    from: ['blocked'],
    to: 'testing',
    validate: (h) => {
      if (!h.testMethod) return 'testMethod is required to start testing';
      return null;
    },
  },
];

// ============================================================================
// Core Functions
// ============================================================================

export function loadHypotheses(): Hypothesis[] {
  try {
    const data = JSON.parse(fs.readFileSync(HYPOTHESES_FILE, 'utf-8'));
    return data.hypotheses || [];
  } catch {
    return [];
  }
}

export function loadHypothesis(id: string): Hypothesis | null {
  const hypotheses = loadHypotheses();
  return hypotheses.find(h => h.id === id) || null;
}

function saveHypotheses(hypotheses: Hypothesis[]): void {
  const data = JSON.parse(fs.readFileSync(HYPOTHESES_FILE, 'utf-8'));
  data.hypotheses = hypotheses;
  fs.writeFileSync(HYPOTHESES_FILE, JSON.stringify(data, null, 2));
}

function saveHypothesis(hypothesis: Hypothesis): void {
  const hypotheses = loadHypotheses();
  const index = hypotheses.findIndex(h => h.id === hypothesis.id);
  if (index >= 0) {
    hypotheses[index] = hypothesis;
  } else {
    hypotheses.push(hypothesis);
  }
  saveHypotheses(hypotheses);
}

/**
 * Transition a hypothesis to a new status.
 * Code validates the transition is legal.
 */
export async function transitionHypothesis(
  hypothesisId: string,
  targetStatus: HypothesisStatus,
  reason: string
): Promise<TransitionResult> {
  const hypothesis = loadHypothesis(hypothesisId);

  if (!hypothesis) {
    return { success: false, error: `Hypothesis ${hypothesisId} not found` };
  }

  // Find valid transition
  const rule = TRANSITIONS.find(t =>
    t.from.includes(hypothesis.status) && t.to === targetStatus
  );

  if (!rule) {
    return {
      success: false,
      error: `Invalid transition: ${hypothesis.status} → ${targetStatus}`,
    };
  }

  // Validate transition
  const validationError = rule.validate(hypothesis);
  if (validationError) {
    return { success: false, error: validationError };
  }

  // Execute transition
  const previousStatus = hypothesis.status;
  hypothesis.status = targetStatus;
  hypothesis.updatedAt = new Date().toISOString();

  // Status-specific actions
  switch (targetStatus) {
    case 'testing':
      hypothesis.testStartedAt = new Date().toISOString();
      break;

    case 'validated':
    case 'invalidated':
      hypothesis.testEndedAt = new Date().toISOString();
      hypothesis.conclusion = reason;
      await logLearning(hypothesis, reason);
      break;

    case 'blocked':
      hypothesis.blockedReason = reason;
      break;
  }

  saveHypothesis(hypothesis);

  // Notify
  await sendMessage(
    `📊 *Hypothesis ${targetStatus}*\n\n` +
    `${hypothesis.id}: ${hypothesis.statement.slice(0, 100)}...\n\n` +
    `${previousStatus} → ${targetStatus}\n` +
    `Reason: ${reason}`
  );

  return { success: true, hypothesis };
}

/**
 * Add evidence to a hypothesis.
 * Code handles confidence calculation, tracking, and auto-transitions.
 */
export async function addEvidence(
  hypothesisId: string,
  observation: string,
  supports: boolean | null,
  confidenceImpact: number
): Promise<TransitionResult> {
  const hypothesis = loadHypothesis(hypothesisId);

  if (!hypothesis) {
    return { success: false, error: `Hypothesis ${hypothesisId} not found` };
  }

  if (!['proposed', 'testing'].includes(hypothesis.status)) {
    return { success: false, error: `Cannot add evidence to ${hypothesis.status} hypothesis` };
  }

  // Add evidence
  hypothesis.evidence.push({
    date: new Date().toISOString(),
    observation,
    supports,
    confidenceImpact,
  });

  // Update confidence (clamped 0-1)
  const previousConfidence = hypothesis.confidence;
  hypothesis.confidence = Math.max(0, Math.min(1, hypothesis.confidence + confidenceImpact));
  hypothesis.updatedAt = new Date().toISOString();

  // Track confidence movement for progress monitoring
  if (Math.abs(hypothesis.confidence - previousConfidence) > 0.001) {
    trackConfidenceChange(
      hypothesisId,
      previousConfidence,
      hypothesis.confidence,
      `Evidence: ${observation.slice(0, 50)}...`
    );
  }

  saveHypothesis(hypothesis);

  // Trigger engine status update (event-driven)
  try {
    const { updateEngineStatus } = require('../daemon');
    updateEngineStatus();
  } catch {
    // Daemon may not be running (e.g., in tests or CLI)
  }

  // Check for auto-transitions
  if (hypothesis.status === 'testing') {
    if (hypothesis.confidence <= CONFIG.autoInvalidateConfidence) {
      return transitionHypothesis(
        hypothesisId,
        'invalidated',
        `Auto-invalidated: confidence dropped to ${(hypothesis.confidence * 100).toFixed(0)}%`
      );
    }

    if (hypothesis.confidence >= CONFIG.autoValidateConfidence && meetsValidationCriteria(hypothesis)) {
      return transitionHypothesis(
        hypothesisId,
        'validated',
        `Auto-validated: confidence reached ${(hypothesis.confidence * 100).toFixed(0)}% with sufficient evidence`
      );
    }
  }

  return { success: true, hypothesis };
}

/**
 * Record a trade result for a hypothesis.
 */
export function recordTradeResult(
  hypothesisId: string,
  won: boolean,
  pnl: number
): TransitionResult {
  const hypothesis = loadHypothesis(hypothesisId);

  if (!hypothesis) {
    return { success: false, error: `Hypothesis ${hypothesisId} not found` };
  }

  // Initialize test results if needed
  if (!hypothesis.testResults) {
    hypothesis.testResults = {
      trades: 0,
      wins: 0,
      losses: 0,
      totalPnL: 0,
      actualWinRate: 0,
    };
  }

  // Update results
  hypothesis.testResults.trades++;
  if (won) {
    hypothesis.testResults.wins++;
  } else {
    hypothesis.testResults.losses++;
  }
  hypothesis.testResults.totalPnL += pnl;
  hypothesis.testResults.actualWinRate =
    hypothesis.testResults.wins / hypothesis.testResults.trades;

  hypothesis.updatedAt = new Date().toISOString();
  saveHypothesis(hypothesis);

  return { success: true, hypothesis };
}

/**
 * Block a hypothesis awaiting a capability.
 * Creates a handoff to Agent Engineer.
 */
export async function blockHypothesis(
  hypothesisId: string,
  capabilityNeeded: string,
  handoffPriority: 'low' | 'medium' | 'high' = 'medium'
): Promise<TransitionResult> {
  const hypothesis = loadHypothesis(hypothesisId);

  if (!hypothesis) {
    return { success: false, error: `Hypothesis ${hypothesisId} not found` };
  }

  // Create handoff
  const handoffId = `handoff-${Date.now().toString(36)}`;
  const handoffs = JSON.parse(fs.readFileSync(HANDOFFS_FILE, 'utf-8'));

  handoffs.handoffs.push({
    id: handoffId,
    from: 'trade-research',
    to: 'agent-engineer',
    type: 'build_capability',
    priority: handoffPriority,
    status: 'pending',
    context: {
      hypothesisId,
      capabilityNeeded,
      hypothesisStatement: hypothesis.statement.slice(0, 200),
    },
    createdAt: new Date().toISOString(),
  });

  fs.writeFileSync(HANDOFFS_FILE, JSON.stringify(handoffs, null, 2));

  // Transition to blocked
  hypothesis.blockedHandoffId = handoffId;
  const result = await transitionHypothesis(
    hypothesisId,
    'blocked',
    `Awaiting capability: ${capabilityNeeded}`
  );

  return result;
}

/**
 * Create a new hypothesis.
 */
export function createHypothesis(params: {
  statement: string;
  rationale: string;
  testMethod: string;
  source?: string;
  entryRules?: string;
  exitRules?: string;
  expectedWinRate?: number;
  expectedPayoff?: number;
  minSampleSize?: number;
  initialConfidence?: number;
}): Hypothesis {
  const id = `hyp-${Date.now().toString(36)}`;
  const now = new Date().toISOString();

  const hypothesis: Hypothesis = {
    id,
    statement: params.statement,
    rationale: params.rationale,
    testMethod: params.testMethod,
    source: params.source,
    entryRules: params.entryRules,
    exitRules: params.exitRules,
    expectedWinRate: params.expectedWinRate,
    expectedPayoff: params.expectedPayoff,
    minSampleSize: params.minSampleSize || CONFIG.defaultMinSampleSize,
    status: 'proposed',
    confidence: params.initialConfidence || 0.5,
    evidence: [],
    createdAt: now,
    updatedAt: now,
  };

  saveHypothesis(hypothesis);

  console.log(`[Hypothesis] Created ${id}: ${params.statement.slice(0, 50)}...`);

  return hypothesis;
}

// ============================================================================
// Helper Functions
// ============================================================================

function meetsValidationCriteria(hypothesis: Hypothesis): boolean {
  if (!hypothesis.testResults) return false;

  const minSamples = hypothesis.minSampleSize || CONFIG.defaultMinSampleSize;
  if (hypothesis.testResults.trades < minSamples) return false;

  if (hypothesis.testResults.actualWinRate < CONFIG.validationWinRate) return false;

  return true;
}

async function logLearning(hypothesis: Hypothesis, conclusion: string): Promise<void> {
  try {
    const learnings = JSON.parse(fs.readFileSync(LEARNINGS_FILE, 'utf-8'));

    const learning = {
      id: `learning-${hypothesis.id}-${Date.now().toString(36)}`,
      category: 'hypothesis',
      title: `${hypothesis.status === 'validated' ? '✅' : '❌'} ${hypothesis.id}: ${hypothesis.statement.slice(0, 50)}...`,
      content: `
## Hypothesis ${hypothesis.status.toUpperCase()}

**Statement:** ${hypothesis.statement}

**Conclusion:** ${conclusion}

**Evidence Summary:**
- Total observations: ${hypothesis.evidence.length}
- Supporting: ${hypothesis.evidence.filter(e => e.supports === true).length}
- Contradicting: ${hypothesis.evidence.filter(e => e.supports === false).length}
- Final confidence: ${(hypothesis.confidence * 100).toFixed(0)}%

${hypothesis.testResults ? `
**Trade Results:**
- Trades: ${hypothesis.testResults.trades}
- Win rate: ${(hypothesis.testResults.actualWinRate * 100).toFixed(0)}%
- Total P&L: $${hypothesis.testResults.totalPnL.toFixed(2)}
` : ''}

**Key Evidence:**
${hypothesis.evidence.slice(-3).map(e =>
  `- ${e.date.split('T')[0]}: ${e.observation.slice(0, 150)}...`
).join('\n')}
      `.trim(),
      source: `Hypothesis ${hypothesis.id} ${hypothesis.status}`,
      actionable: hypothesis.status === 'validated',
      appliedTo: [hypothesis.id],
      createdAt: new Date().toISOString(),
    };

    learnings.insights.push(learning);
    fs.writeFileSync(LEARNINGS_FILE, JSON.stringify(learnings, null, 2));
  } catch (error) {
    console.error('[Hypothesis] Failed to log learning:', error);
  }
}

// ============================================================================
// Learning-Informed Confidence
// ============================================================================

export interface Learning {
  id: string;
  category: string;
  title: string;
  content: string;
  source: string;
  actionable: boolean;
  appliedTo: string[];
  createdAt: string;
  references?: string[];
}

export interface ConfidenceMovement {
  hypothesisId: string;
  previousConfidence: number;
  currentConfidence: number;
  delta: number;
  reason: string;
  timestamp: string;
}

// Track confidence movements in state
const CONFIDENCE_HISTORY_FILE = path.join(STATE_DIR, 'trading/confidence-history.json');

function loadLearnings(): Learning[] {
  try {
    const data = JSON.parse(fs.readFileSync(LEARNINGS_FILE, 'utf-8'));
    return data.insights || [];
  } catch {
    return [];
  }
}

/**
 * Find learnings related to a hypothesis based on:
 * - Direct appliedTo linkage
 * - Category match (strategy, market, hypothesis)
 * - Content similarity (keyword matching)
 */
export function getRelatedLearnings(hypothesis: Hypothesis): Learning[] {
  const learnings = loadLearnings();
  const related: Learning[] = [];

  // Keywords to match from hypothesis statement and rationale
  const hypothesisText = `${hypothesis.statement} ${hypothesis.rationale} ${hypothesis.testMethod || ''}`.toLowerCase();
  const keywords = extractKeywords(hypothesisText);

  for (const learning of learnings) {
    // Direct linkage - highest priority
    if (learning.appliedTo?.includes(hypothesis.id)) {
      related.push(learning);
      continue;
    }

    // Category matches for hypothesis-related learnings
    if (['hypothesis', 'strategy', 'market'].includes(learning.category)) {
      const learningText = `${learning.title} ${learning.content}`.toLowerCase();

      // Check for keyword matches
      const matchCount = keywords.filter(kw => learningText.includes(kw)).length;
      if (matchCount >= 2) {
        related.push(learning);
      }
    }
  }

  return related;
}

/**
 * Extract meaningful keywords for matching
 */
function extractKeywords(text: string): string[] {
  // Common trading/market keywords to look for
  const importantTerms = [
    'momentum', 'arbitrage', 'spread', 'liquidity', 'volatility',
    'market maker', 'mm', 'sports', 'crypto', 'politics', 'election',
    'contrarian', 'mean reversion', 'trend', 'overpriced', 'underpriced',
    'tail risk', 'edge', 'mispricing', 'polymarket', 'closing',
    'leaderboard', 'top traders', 'hft', 'high frequency',
  ];

  return importantTerms.filter(term => text.includes(term));
}

/**
 * Apply learnings to adjust hypothesis confidence.
 * Returns a confidence adjustment (-0.2 to +0.2) based on related learnings.
 */
export function calculateLearningsImpact(hypothesis: Hypothesis): {
  adjustment: number;
  reasoning: string;
  relatedLearnings: string[];
} {
  const related = getRelatedLearnings(hypothesis);

  if (related.length === 0) {
    return { adjustment: 0, reasoning: 'No related learnings found', relatedLearnings: [] };
  }

  let adjustment = 0;
  const reasons: string[] = [];
  const learningIds: string[] = [];

  for (const learning of related) {
    learningIds.push(learning.id);
    const content = learning.content.toLowerCase();

    // Check for validated/invalidated signals
    if (content.includes('validated') || content.includes('working') || content.includes('confirmed')) {
      if (content.includes('hypothesis')) {
        adjustment += 0.05;
        reasons.push(`${learning.id}: Similar hypothesis validated`);
      }
    }

    if (content.includes('invalidated') || content.includes('not working') || content.includes('failed')) {
      if (content.includes('hypothesis')) {
        adjustment -= 0.05;
        reasons.push(`${learning.id}: Similar hypothesis invalidated`);
      }
    }

    // Check for cautionary learnings
    if (content.includes('misleading') || content.includes('false positive') || content.includes('doesn\'t work')) {
      adjustment -= 0.03;
      reasons.push(`${learning.id}: Cautionary insight`);
    }

    // Check for actionable positive insights
    if (learning.actionable && content.includes('opportunity') || content.includes('+ev') || content.includes('edge')) {
      adjustment += 0.02;
      reasons.push(`${learning.id}: Actionable opportunity identified`);
    }
  }

  // Clamp adjustment to reasonable bounds
  adjustment = Math.max(-0.2, Math.min(0.2, adjustment));

  return {
    adjustment,
    reasoning: reasons.join('; ') || 'Related learnings found but no clear signal',
    relatedLearnings: learningIds,
  };
}

/**
 * Track confidence movement for progress monitoring
 */
export function trackConfidenceChange(
  hypothesisId: string,
  previousConfidence: number,
  currentConfidence: number,
  reason: string
): void {
  const movement: ConfidenceMovement = {
    hypothesisId,
    previousConfidence,
    currentConfidence,
    delta: currentConfidence - previousConfidence,
    reason,
    timestamp: new Date().toISOString(),
  };

  try {
    let history: ConfidenceMovement[] = [];
    if (fs.existsSync(CONFIDENCE_HISTORY_FILE)) {
      history = JSON.parse(fs.readFileSync(CONFIDENCE_HISTORY_FILE, 'utf-8'));
    }
    history.push(movement);

    // Keep last 500 movements
    if (history.length > 500) {
      history = history.slice(-500);
    }

    fs.writeFileSync(CONFIDENCE_HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (error) {
    console.error('[Hypothesis] Failed to track confidence change:', error);
  }
}

/**
 * Get weekly progress metrics
 */
export function getWeeklyProgress(): {
  totalMovement: number;
  hypothesesAdvanced: number;
  thresholdCrossings: number;
  movements: ConfidenceMovement[];
} {
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  let history: ConfidenceMovement[] = [];
  try {
    if (fs.existsSync(CONFIDENCE_HISTORY_FILE)) {
      history = JSON.parse(fs.readFileSync(CONFIDENCE_HISTORY_FILE, 'utf-8'));
    }
  } catch {
    history = [];
  }

  const weekMovements = history.filter(m => m.timestamp >= oneWeekAgo);

  const totalMovement = weekMovements.reduce((sum, m) => sum + Math.abs(m.delta), 0);

  // Count threshold crossings (crossed 50% or 75%)
  let thresholdCrossings = 0;
  for (const m of weekMovements) {
    const crossed50 = (m.previousConfidence < 0.5 && m.currentConfidence >= 0.5) ||
                      (m.previousConfidence >= 0.5 && m.currentConfidence < 0.5);
    const crossed75 = (m.previousConfidence < 0.75 && m.currentConfidence >= 0.75) ||
                      (m.previousConfidence >= 0.75 && m.currentConfidence < 0.75);
    if (crossed50 || crossed75) thresholdCrossings++;
  }

  // Count unique hypotheses that had meaningful movement (>5%)
  const hypothesesAdvanced = new Set(
    weekMovements.filter(m => Math.abs(m.delta) >= 0.05).map(m => m.hypothesisId)
  ).size;

  return {
    totalMovement,
    hypothesesAdvanced,
    thresholdCrossings,
    movements: weekMovements,
  };
}

// ============================================================================
// Hypothesis Prioritization & Selection
// ============================================================================

export interface HypothesisPriorityScore {
  hypothesisId: string;
  score: number;
  breakdown: {
    confidence: number;
    learningsSupport: number;
    timeSensitivity: number;
    infrastructureReady: number;
    potentialEdge: number;
  };
}

/**
 * Calculate priority score for hypothesis selection.
 * Higher score = should be worked on next.
 */
export function calculatePriorityScore(hypothesis: Hypothesis): HypothesisPriorityScore {
  // Weight factors
  const weights = {
    confidence: 0.30,
    learningsSupport: 0.20,
    timeSensitivity: 0.20,
    infrastructureReady: 0.15,
    potentialEdge: 0.15,
  };

  // 1. Confidence score (0-1)
  const confidenceScore = hypothesis.confidence;

  // 2. Learnings support (0-1)
  const learningsImpact = calculateLearningsImpact(hypothesis);
  const learningsSupportScore = Math.max(0, Math.min(1, 0.5 + learningsImpact.adjustment));

  // 3. Time sensitivity (0-1)
  // Check if hypothesis mentions time-sensitive markets or has testEndedAt close
  let timeSensitivityScore = 0.3; // default
  const text = `${hypothesis.statement} ${hypothesis.testMethod || ''}`.toLowerCase();
  if (text.includes('closing') || text.includes('expires') || text.includes('deadline')) {
    timeSensitivityScore = 0.8;
  }
  if (text.includes('24 hour') || text.includes('tomorrow') || text.includes('this week')) {
    timeSensitivityScore = 1.0;
  }

  // 4. Infrastructure ready (0 or 1)
  const infrastructureReadyScore = hypothesis.status === 'blocked' ? 0 : 1;

  // 5. Potential edge (0-1) - based on expected values
  let potentialEdgeScore = 0.5; // default
  if (hypothesis.expectedWinRate && hypothesis.expectedPayoff) {
    // Kelly criterion approximation for edge
    const edge = hypothesis.expectedWinRate * hypothesis.expectedPayoff - (1 - hypothesis.expectedWinRate);
    potentialEdgeScore = Math.max(0, Math.min(1, edge));
  }

  // Calculate weighted score
  const score =
    weights.confidence * confidenceScore +
    weights.learningsSupport * learningsSupportScore +
    weights.timeSensitivity * timeSensitivityScore +
    weights.infrastructureReady * infrastructureReadyScore +
    weights.potentialEdge * potentialEdgeScore;

  return {
    hypothesisId: hypothesis.id,
    score,
    breakdown: {
      confidence: confidenceScore,
      learningsSupport: learningsSupportScore,
      timeSensitivity: timeSensitivityScore,
      infrastructureReady: infrastructureReadyScore,
      potentialEdge: potentialEdgeScore,
    },
  };
}

/**
 * Get top N testable hypotheses by priority score
 */
export function getTopTestableHypotheses(n: number = 3): Array<Hypothesis & { priorityScore: HypothesisPriorityScore }> {
  const testable = getTestableHypotheses();

  const scored = testable.map(h => ({
    ...h,
    priorityScore: calculatePriorityScore(h),
  }));

  return scored
    .sort((a, b) => b.priorityScore.score - a.priorityScore.score)
    .slice(0, n);
}

/**
 * Select the next hypothesis to focus on.
 * Returns the highest-scored hypothesis that isn't blocked.
 */
export function selectNextHypothesis(): {
  hypothesis: Hypothesis | null;
  score: HypothesisPriorityScore | null;
  alternatives: Array<{ id: string; score: number }>;
} {
  const top = getTopTestableHypotheses(5);

  if (top.length === 0) {
    return { hypothesis: null, score: null, alternatives: [] };
  }

  const selected = top[0];
  const alternatives = top.slice(1).map(h => ({
    id: h.id,
    score: h.priorityScore.score,
  }));

  return {
    hypothesis: selected,
    score: selected.priorityScore,
    alternatives,
  };
}

// ============================================================================
// Query Functions
// ============================================================================

export function getActiveHypotheses(): Hypothesis[] {
  return loadHypotheses().filter(h =>
    ['proposed', 'testing'].includes(h.status)
  );
}

export function getTestableHypotheses(): Hypothesis[] {
  return loadHypotheses().filter(h =>
    ['proposed', 'testing'].includes(h.status) && h.confidence > 0.30
  );
}

export function getBlockedHypotheses(): Hypothesis[] {
  return loadHypotheses().filter(h => h.status === 'blocked');
}

/**
 * Check if a hypothesis has sufficient validation for larger trades (>$50).
 * Returns true if:
 * - Has backtest results with positive metrics, OR
 * - Has sufficient evidence (5+ observations) with confidence > 55%
 */
export function hasTradeValidation(hypothesisId: string): {
  validated: boolean;
  reason: string;
  backtestData?: BacktestResults;
} {
  const hypothesis = loadHypothesis(hypothesisId);

  if (!hypothesis) {
    return { validated: false, reason: 'Hypothesis not found' };
  }

  // Check backtest results first (strongest validation)
  if (hypothesis.backtestResults) {
    const bt = hypothesis.backtestResults;
    if (bt.winRate >= 0.45 && bt.sampleSize >= 10) {
      return {
        validated: true,
        reason: `Backtest: ${bt.sampleSize} samples, ${(bt.winRate * 100).toFixed(0)}% win rate`,
        backtestData: bt,
      };
    } else {
      return {
        validated: false,
        reason: `Backtest insufficient: ${bt.sampleSize} samples, ${(bt.winRate * 100).toFixed(0)}% win rate (need ≥10 samples, ≥45% win rate)`,
        backtestData: bt,
      };
    }
  }

  // Fall back to evidence-based validation
  const minEvidence = 5;
  const minConfidence = 0.55;

  if (hypothesis.evidence.length >= minEvidence && hypothesis.confidence >= minConfidence) {
    const supportingEvidence = hypothesis.evidence.filter(e => e.supports === true).length;
    return {
      validated: true,
      reason: `Evidence: ${hypothesis.evidence.length} observations, ${(hypothesis.confidence * 100).toFixed(0)}% confidence, ${supportingEvidence} supporting`,
    };
  }

  // Not validated
  const needs: string[] = [];
  if (hypothesis.evidence.length < minEvidence) {
    needs.push(`${minEvidence - hypothesis.evidence.length} more observations`);
  }
  if (hypothesis.confidence < minConfidence) {
    needs.push(`confidence ${(hypothesis.confidence * 100).toFixed(0)}% → ${minConfidence * 100}%`);
  }

  return {
    validated: false,
    reason: `Needs: ${needs.join(', ')}. Either add backtest results or gather more evidence.`,
  };
}

export function getHypothesisSummary(): string {
  const hypotheses = loadHypotheses();

  const byStatus = {
    proposed: hypotheses.filter(h => h.status === 'proposed'),
    testing: hypotheses.filter(h => h.status === 'testing'),
    validated: hypotheses.filter(h => h.status === 'validated'),
    invalidated: hypotheses.filter(h => h.status === 'invalidated'),
    blocked: hypotheses.filter(h => h.status === 'blocked'),
  };

  const formatList = (list: Hypothesis[]) =>
    list.map(h => `  - ${h.id}: ${h.statement.slice(0, 60)}... (${(h.confidence * 100).toFixed(0)}%)`).join('\n');

  return `
## Hypothesis Summary

**Proposed (${byStatus.proposed.length}):**
${formatList(byStatus.proposed) || '  (none)'}

**Testing (${byStatus.testing.length}):**
${formatList(byStatus.testing) || '  (none)'}

**Blocked (${byStatus.blocked.length}):**
${formatList(byStatus.blocked) || '  (none)'}

**Validated (${byStatus.validated.length}):**
${formatList(byStatus.validated) || '  (none)'}

**Invalidated (${byStatus.invalidated.length}):**
${formatList(byStatus.invalidated) || '  (none)'}
  `.trim();
}
