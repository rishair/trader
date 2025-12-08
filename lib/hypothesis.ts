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
 * Code handles confidence calculation and auto-transitions.
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
  hypothesis.confidence = Math.max(0, Math.min(1, hypothesis.confidence + confidenceImpact));
  hypothesis.updatedAt = new Date().toISOString();

  saveHypothesis(hypothesis);

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
