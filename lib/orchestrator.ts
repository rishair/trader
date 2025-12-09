/**
 * Strategic Orchestrator
 *
 * Provides dynamic prioritization for the daemon.
 * Instead of mechanically running scheduled responsibilities,
 * this module identifies what ACTUALLY matters right now.
 *
 * Code gathers signals and calculates urgency.
 * Models (if spawned) make judgment calls on ambiguous situations.
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadPortfolio } from './trading';

const STATE_DIR = path.join(__dirname, '..', 'state');
const HYPOTHESES_FILE = path.join(STATE_DIR, 'trading/hypotheses.json');
const ENGINE_STATUS_FILE = path.join(STATE_DIR, 'trading/engine-status.json');
const HEALTH_FILE = path.join(STATE_DIR, 'agent-engineering/health.json');
const SCHEDULE_FILE = path.join(STATE_DIR, 'orchestrator/schedule.json');

// ============================================================================
// Types
// ============================================================================

export type PriorityType =
  | 'portfolio-risk'       // Position needs immediate attention
  | 'exit-trigger'         // Stop loss or take profit hit
  | 'time-sensitive'       // Market closing soon, decision needed
  | 'stuck-hypothesis'     // Hypothesis blocked for too long
  | 'execution-velocity'   // Not enough trades happening
  | 'system-health'        // Infrastructure issue detected
  | 'scheduled';           // Normal scheduled responsibility

export interface Priority {
  type: PriorityType;
  urgency: number;         // 0-100, higher = more urgent
  action: string;          // What to do
  context: any;            // Relevant data
  spawnsAgent: boolean;    // Does this need a model, or can code handle it?
  agentRole?: 'trade-research' | 'agent-engineer';
  focusedPrompt?: string;  // If spawning agent, give them focused context
}

export interface OrchestratorDecision {
  shouldOverride: boolean;
  priority?: Priority;
  reason: string;
}

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  // Portfolio risk thresholds
  positionLossWarningPct: -15,    // Warn when position down 15%
  positionLossCriticalPct: -25,   // Critical when down 25%
  nearStopLossBuffer: 1.1,        // Alert when within 10% of stop loss

  // Time sensitivity
  marketClosingHoursUrgent: 24,   // Markets closing within 24h need attention
  marketClosingHoursCritical: 6,  // Within 6h is critical

  // Hypothesis health
  stuckHypothesisHours: 48,       // Hypothesis stuck in same state for 48h
  lowConfidenceThreshold: 0.30,   // Below this, should probably kill

  // Execution velocity
  minTradesPerWeek: 5,            // Target minimum trades
  velocityCriticalDays: 7,        // After 7 days with low velocity, it's critical

  // System health
  maxPipelineFailures: 3,         // Alert after 3 consecutive failures
  maxErrorsPerHour: 10,           // Alert if >10 errors in past hour
  staleHealthCheckHours: 6,       // Alert if health not updated in 6h
};

// ============================================================================
// Priority Detection (Code does the work)
// ============================================================================

/**
 * Scan for all priorities. Code detects signals, calculates urgency.
 */
export function detectPriorities(): Priority[] {
  const priorities: Priority[] = [];

  // 1. Portfolio risk signals
  priorities.push(...detectPortfolioRisks());

  // 2. Time-sensitive opportunities
  priorities.push(...detectTimeSensitive());

  // 3. Stuck hypotheses
  priorities.push(...detectStuckHypotheses());

  // 4. Execution velocity
  priorities.push(...detectVelocityIssues());

  // 5. System health issues
  priorities.push(...detectSystemHealthIssues());

  // Sort by urgency (highest first)
  return priorities.sort((a, b) => b.urgency - a.urgency);
}

function detectPortfolioRisks(): Priority[] {
  const priorities: Priority[] = [];

  try {
    const portfolio = loadPortfolio();

    for (const position of portfolio.positions) {
      const pnlPct = (position.currentPrice - position.entryPrice) / position.entryPrice * 100;

      // Critical loss
      if (pnlPct <= CONFIG.positionLossCriticalPct) {
        priorities.push({
          type: 'portfolio-risk',
          urgency: 95,
          action: 'review-critical-position',
          context: {
            positionId: position.id,
            market: position.market,
            pnlPct,
            currentPrice: position.currentPrice,
            stopLoss: position.exitCriteria.stopLoss,
          },
          spawnsAgent: true,
          agentRole: 'trade-research',
          focusedPrompt: buildPositionReviewPrompt(position, 'critical'),
        });
      }
      // Warning loss
      else if (pnlPct <= CONFIG.positionLossWarningPct) {
        priorities.push({
          type: 'portfolio-risk',
          urgency: 75,
          action: 'review-underwater-position',
          context: {
            positionId: position.id,
            market: position.market,
            pnlPct,
          },
          spawnsAgent: true,
          agentRole: 'trade-research',
          focusedPrompt: buildPositionReviewPrompt(position, 'warning'),
        });
      }

      // Near stop loss
      const stopLossBuffer = position.exitCriteria.stopLoss * CONFIG.nearStopLossBuffer;
      if (position.currentPrice <= stopLossBuffer && position.currentPrice > position.exitCriteria.stopLoss) {
        priorities.push({
          type: 'exit-trigger',
          urgency: 85,
          action: 'stop-loss-warning',
          context: {
            positionId: position.id,
            market: position.market,
            currentPrice: position.currentPrice,
            stopLoss: position.exitCriteria.stopLoss,
            distanceToStop: ((position.currentPrice - position.exitCriteria.stopLoss) / position.exitCriteria.stopLoss * 100).toFixed(1),
          },
          spawnsAgent: true,
          agentRole: 'trade-research',
          focusedPrompt: buildStopLossWarningPrompt(position),
        });
      }

      // Hit stop loss (code can handle this)
      if (position.currentPrice <= position.exitCriteria.stopLoss) {
        priorities.push({
          type: 'exit-trigger',
          urgency: 99,
          action: 'execute-stop-loss',
          context: {
            positionId: position.id,
            market: position.market,
            currentPrice: position.currentPrice,
            stopLoss: position.exitCriteria.stopLoss,
          },
          spawnsAgent: false,  // Code handles this
        });
      }

      // Hit take profit (code can handle this)
      if (position.currentPrice >= position.exitCriteria.takeProfit) {
        priorities.push({
          type: 'exit-trigger',
          urgency: 98,
          action: 'execute-take-profit',
          context: {
            positionId: position.id,
            market: position.market,
            currentPrice: position.currentPrice,
            takeProfit: position.exitCriteria.takeProfit,
          },
          spawnsAgent: false,  // Code handles this
        });
      }
    }
  } catch (error) {
    console.error('[Orchestrator] Failed to detect portfolio risks:', error);
  }

  return priorities;
}

function detectTimeSensitive(): Priority[] {
  const priorities: Priority[] = [];

  try {
    // Check hypotheses with linked markets closing soon
    const hypotheses = JSON.parse(fs.readFileSync(HYPOTHESES_FILE, 'utf-8')).hypotheses || [];

    for (const hyp of hypotheses) {
      if (!['proposed', 'testing'].includes(hyp.status)) continue;
      if (!hyp.trackingMarkets) continue;

      for (const market of hyp.trackingMarkets) {
        if (!market.closesAt) continue;

        const hoursToClose = (new Date(market.closesAt).getTime() - Date.now()) / (1000 * 60 * 60);

        if (hoursToClose <= CONFIG.marketClosingHoursCritical && hoursToClose > 0) {
          priorities.push({
            type: 'time-sensitive',
            urgency: 90,
            action: 'closing-market-critical',
            context: {
              hypothesisId: hyp.id,
              market: market.market,
              hoursToClose: hoursToClose.toFixed(1),
            },
            spawnsAgent: true,
            agentRole: 'trade-research',
            focusedPrompt: buildClosingMarketPrompt(hyp, market, 'critical'),
          });
        } else if (hoursToClose <= CONFIG.marketClosingHoursUrgent && hoursToClose > 0) {
          priorities.push({
            type: 'time-sensitive',
            urgency: 70,
            action: 'closing-market-soon',
            context: {
              hypothesisId: hyp.id,
              market: market.market,
              hoursToClose: hoursToClose.toFixed(1),
            },
            spawnsAgent: true,
            agentRole: 'trade-research',
            focusedPrompt: buildClosingMarketPrompt(hyp, market, 'warning'),
          });
        }
      }
    }
  } catch (error) {
    console.error('[Orchestrator] Failed to detect time-sensitive:', error);
  }

  return priorities;
}

function detectStuckHypotheses(): Priority[] {
  const priorities: Priority[] = [];

  try {
    const hypotheses = JSON.parse(fs.readFileSync(HYPOTHESES_FILE, 'utf-8')).hypotheses || [];

    for (const hyp of hypotheses) {
      if (!['proposed', 'testing'].includes(hyp.status)) continue;

      const lastUpdate = new Date(hyp.updatedAt || hyp.createdAt);
      const hoursStuck = (Date.now() - lastUpdate.getTime()) / (1000 * 60 * 60);

      // Stuck in proposed
      if (hyp.status === 'proposed' && hoursStuck > CONFIG.stuckHypothesisHours) {
        priorities.push({
          type: 'stuck-hypothesis',
          urgency: 60,
          action: 'unstick-proposed-hypothesis',
          context: {
            hypothesisId: hyp.id,
            statement: hyp.statement,
            hoursStuck: hoursStuck.toFixed(0),
            confidence: hyp.confidence,
          },
          spawnsAgent: true,
          agentRole: 'trade-research',
          focusedPrompt: buildStuckHypothesisPrompt(hyp, 'proposed'),
        });
      }

      // Low confidence while testing
      if (hyp.status === 'testing' && hyp.confidence < CONFIG.lowConfidenceThreshold) {
        priorities.push({
          type: 'stuck-hypothesis',
          urgency: 65,
          action: 'review-low-confidence-hypothesis',
          context: {
            hypothesisId: hyp.id,
            statement: hyp.statement,
            confidence: hyp.confidence,
            evidenceCount: hyp.evidence?.length || 0,
          },
          spawnsAgent: true,
          agentRole: 'trade-research',
          focusedPrompt: buildLowConfidencePrompt(hyp),
        });
      }
    }
  } catch (error) {
    console.error('[Orchestrator] Failed to detect stuck hypotheses:', error);
  }

  return priorities;
}

function detectVelocityIssues(): Priority[] {
  const priorities: Priority[] = [];

  try {
    const portfolio = loadPortfolio();

    // Count trades in last 7 days
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentTrades = portfolio.tradeHistory.filter(
      (t: any) => new Date(t.timestamp).getTime() > weekAgo
    );

    if (recentTrades.length < CONFIG.minTradesPerWeek) {
      const urgency = recentTrades.length === 0 ? 70 : 50;

      priorities.push({
        type: 'execution-velocity',
        urgency,
        action: 'increase-trade-velocity',
        context: {
          tradesLast7Days: recentTrades.length,
          target: CONFIG.minTradesPerWeek,
          hypothesesAvailable: countTestableHypotheses(),
        },
        spawnsAgent: true,
        agentRole: 'trade-research',
        focusedPrompt: buildVelocityPrompt(recentTrades.length),
      });
    }
  } catch (error) {
    console.error('[Orchestrator] Failed to detect velocity issues:', error);
  }

  return priorities;
}

function countTestableHypotheses(): number {
  try {
    const hypotheses = JSON.parse(fs.readFileSync(HYPOTHESES_FILE, 'utf-8')).hypotheses || [];
    return hypotheses.filter((h: any) =>
      ['proposed', 'testing'].includes(h.status) && h.confidence > 0.30
    ).length;
  } catch {
    return 0;
  }
}

function detectSystemHealthIssues(): Priority[] {
  const priorities: Priority[] = [];

  try {
    // Check health.json for issues
    const healthIssues = checkHealthFile();
    priorities.push(...healthIssues);

    // Check for pipeline failures
    const pipelineIssues = checkPipelineHealth();
    priorities.push(...pipelineIssues);

    // Check for stale data
    const stalenessIssues = checkDataStaleness();
    priorities.push(...stalenessIssues);

  } catch (error) {
    console.error('[Orchestrator] Failed to detect system health issues:', error);
  }

  return priorities;
}

function checkHealthFile(): Priority[] {
  const priorities: Priority[] = [];

  try {
    if (!fs.existsSync(HEALTH_FILE)) {
      priorities.push({
        type: 'system-health',
        urgency: 60,
        action: 'create-health-file',
        context: { issue: 'health.json does not exist' },
        spawnsAgent: true,
        agentRole: 'agent-engineer',
        focusedPrompt: buildSystemHealthPrompt('Health file missing', 'Create state/agent-engineering/health.json with current system status'),
      });
      return priorities;
    }

    const health = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf-8'));

    // Check for recent errors
    const recentErrors = (health.recentErrors || []).filter((e: any) => {
      const errorTime = new Date(e.timestamp).getTime();
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      return errorTime > oneHourAgo;
    });

    if (recentErrors.length >= CONFIG.maxErrorsPerHour) {
      priorities.push({
        type: 'system-health',
        urgency: 80,
        action: 'investigate-errors',
        context: {
          errorCount: recentErrors.length,
          threshold: CONFIG.maxErrorsPerHour,
          recentErrors: recentErrors.slice(-3).map((e: any) => e.message),
        },
        spawnsAgent: true,
        agentRole: 'agent-engineer',
        focusedPrompt: buildSystemHealthPrompt(
          `${recentErrors.length} errors in past hour`,
          `Investigate and fix: ${recentErrors.slice(-3).map((e: any) => e.message).join(', ')}`
        ),
      });
    }

    // Check for stale health check
    if (health.lastCheck) {
      const lastCheckTime = new Date(health.lastCheck).getTime();
      const hoursSinceCheck = (Date.now() - lastCheckTime) / (1000 * 60 * 60);

      if (hoursSinceCheck > CONFIG.staleHealthCheckHours) {
        priorities.push({
          type: 'system-health',
          urgency: 50,
          action: 'run-health-check',
          context: {
            hoursSinceLastCheck: hoursSinceCheck.toFixed(1),
            threshold: CONFIG.staleHealthCheckHours,
          },
          spawnsAgent: false, // Can be handled by pipeline
        });
      }
    }

    // Check service status
    const services = health.services || {};
    for (const [name, status] of Object.entries(services)) {
      if (status === 'error' || status === 'down') {
        priorities.push({
          type: 'system-health',
          urgency: 85,
          action: 'fix-service',
          context: { service: name, status },
          spawnsAgent: true,
          agentRole: 'agent-engineer',
          focusedPrompt: buildSystemHealthPrompt(
            `Service ${name} is ${status}`,
            `Diagnose and fix the ${name} service`
          ),
        });
      }
    }

  } catch (error) {
    // Can't read health file - not critical but worth noting
    console.error('[Orchestrator] Failed to check health file:', error);
  }

  return priorities;
}

function checkPipelineHealth(): Priority[] {
  const priorities: Priority[] = [];

  try {
    if (!fs.existsSync(SCHEDULE_FILE)) {
      return priorities;
    }

    const schedule = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf-8'));
    const completedTasks = schedule.completedTasks || [];

    // Group recent tasks by pipeline name
    const pipelineResults: Record<string, { successes: number; failures: number; lastFailure?: string }> = {};

    // Look at last 24 hours of completed tasks
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const recentTasks = completedTasks.filter((t: any) =>
      t.type === 'pipeline' && new Date(t.completedAt || t.timestamp).getTime() > dayAgo
    );

    for (const task of recentTasks) {
      const name = task.context?.pipeline || 'unknown';
      if (!pipelineResults[name]) {
        pipelineResults[name] = { successes: 0, failures: 0 };
      }
      if (task.result?.success) {
        pipelineResults[name].successes++;
      } else {
        pipelineResults[name].failures++;
        pipelineResults[name].lastFailure = task.result?.error || 'Unknown error';
      }
    }

    // Alert on pipelines with multiple failures
    for (const [name, results] of Object.entries(pipelineResults)) {
      if (results.failures >= CONFIG.maxPipelineFailures) {
        priorities.push({
          type: 'system-health',
          urgency: 75,
          action: 'fix-failing-pipeline',
          context: {
            pipeline: name,
            failures: results.failures,
            successes: results.successes,
            lastError: results.lastFailure,
          },
          spawnsAgent: true,
          agentRole: 'agent-engineer',
          focusedPrompt: buildSystemHealthPrompt(
            `Pipeline ${name} failing (${results.failures} failures in 24h)`,
            `Last error: ${results.lastFailure}. Fix the pipeline.`
          ),
        });
      }
    }

  } catch (error) {
    console.error('[Orchestrator] Failed to check pipeline health:', error);
  }

  return priorities;
}

function checkDataStaleness(): Priority[] {
  const priorities: Priority[] = [];

  try {
    // Check if key state files exist and are recent
    const criticalFiles = [
      { path: path.join(STATE_DIR, 'trading/portfolio.json'), name: 'portfolio', maxAgeHours: 24 },
      { path: path.join(STATE_DIR, 'trading/hypotheses.json'), name: 'hypotheses', maxAgeHours: 48 },
      { path: SCHEDULE_FILE, name: 'schedule', maxAgeHours: 2 },
    ];

    for (const file of criticalFiles) {
      if (!fs.existsSync(file.path)) {
        priorities.push({
          type: 'system-health',
          urgency: 90,
          action: 'missing-critical-file',
          context: { file: file.name, path: file.path },
          spawnsAgent: true,
          agentRole: 'agent-engineer',
          focusedPrompt: buildSystemHealthPrompt(
            `Critical file missing: ${file.name}`,
            `File ${file.path} does not exist. Create or restore it.`
          ),
        });
        continue;
      }

      const stats = fs.statSync(file.path);
      const hoursSinceModified = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);

      if (hoursSinceModified > file.maxAgeHours) {
        priorities.push({
          type: 'system-health',
          urgency: 55,
          action: 'stale-data-file',
          context: {
            file: file.name,
            hoursSinceModified: hoursSinceModified.toFixed(1),
            maxAge: file.maxAgeHours,
          },
          spawnsAgent: false, // Informational
        });
      }
    }

  } catch (error) {
    console.error('[Orchestrator] Failed to check data staleness:', error);
  }

  return priorities;
}

function buildSystemHealthPrompt(issue: string, task: string): string {
  return `
## 🔧 System Health Issue

### Issue: ${issue}

### Your Task
${task}

### Guidelines
1. Diagnose the root cause
2. Implement a fix
3. Verify the fix works
4. Update health.json with the resolution

### Updating Health Status
After fixing, update state/agent-engineering/health.json:
\`\`\`json
{
  "lastCheck": "ISO timestamp",
  "services": { "daemon": "ok", "telegram": "ok" },
  "recentErrors": []
}
\`\`\`
`.trim();
}

// ============================================================================
// Decision Making
// ============================================================================

/**
 * Main entry point: Should we override the scheduled responsibility?
 */
export function getStrategicDecision(): OrchestratorDecision {
  const priorities = detectPriorities();

  if (priorities.length === 0) {
    return {
      shouldOverride: false,
      reason: 'No urgent priorities detected',
    };
  }

  const topPriority = priorities[0];

  // High urgency (>70) always overrides
  if (topPriority.urgency > 70) {
    return {
      shouldOverride: true,
      priority: topPriority,
      reason: `High urgency (${topPriority.urgency}): ${topPriority.action}`,
    };
  }

  // Medium urgency (50-70) overrides if it's been a while since addressed
  if (topPriority.urgency >= 50) {
    // For now, override if urgency > 50
    // Later: track last time each priority type was addressed
    return {
      shouldOverride: true,
      priority: topPriority,
      reason: `Medium urgency (${topPriority.urgency}): ${topPriority.action}`,
    };
  }

  return {
    shouldOverride: false,
    reason: `Top priority urgency (${topPriority.urgency}) below threshold`,
  };
}

/**
 * Get all current priorities for status display.
 */
export function getPriorityReport(): string {
  const priorities = detectPriorities();

  if (priorities.length === 0) {
    return '✅ No urgent priorities. System operating normally.';
  }

  const lines = priorities.slice(0, 5).map((p, i) => {
    const urgencyEmoji = p.urgency >= 90 ? '🔴' : p.urgency >= 70 ? '🟠' : p.urgency >= 50 ? '🟡' : '🟢';
    return `${i + 1}. ${urgencyEmoji} [${p.urgency}] ${p.action}\n   ${JSON.stringify(p.context).slice(0, 100)}...`;
  });

  return `## Current Priorities\n\n${lines.join('\n\n')}`;
}

// ============================================================================
// Focused Prompt Builders
// ============================================================================

function buildPositionReviewPrompt(position: any, severity: 'critical' | 'warning'): string {
  const pnlPct = ((position.currentPrice - position.entryPrice) / position.entryPrice * 100).toFixed(1);

  return `
## ${severity === 'critical' ? '🔴 CRITICAL' : '🟠 WARNING'}: Position Review Required

### Position: ${position.market}
- Entry: ${(position.entryPrice * 100).toFixed(1)}¢
- Current: ${(position.currentPrice * 100).toFixed(1)}¢
- P&L: ${pnlPct}% ($${position.unrealizedPnL?.toFixed(2) || 'N/A'})
- Stop Loss: ${(position.exitCriteria.stopLoss * 100).toFixed(1)}¢
- Hypothesis: ${position.hypothesisId}

### Your Task
1. **Assess**: Is the original thesis still valid?
2. **Decide**: Hold, exit, or adjust stop loss?
3. **Act**: Use \`exitPosition()\` if exiting, or explain why holding.

Import: \`import { exitPosition } from './lib/trading';\`
`.trim();
}

function buildStopLossWarningPrompt(position: any): string {
  return `
## ⚠️ Stop Loss Warning

### Position: ${position.market}
- Current: ${(position.currentPrice * 100).toFixed(1)}¢
- Stop Loss: ${(position.exitCriteria.stopLoss * 100).toFixed(1)}¢
- Distance: ${((position.currentPrice - position.exitCriteria.stopLoss) / position.exitCriteria.stopLoss * 100).toFixed(1)}% above stop

### Your Task
Position is approaching stop loss. Decide:
1. **Let it ride**: Stop loss will trigger automatically if hit
2. **Exit now**: Cut losses before stop is hit
3. **Adjust stop**: Lower stop loss (only if thesis changed)

If exiting: \`import { exitPosition } from './lib/trading';\`
`.trim();
}

function buildClosingMarketPrompt(hyp: any, market: any, severity: 'critical' | 'warning'): string {
  return `
## ${severity === 'critical' ? '🔴 URGENT' : '🟠 ATTENTION'}: Market Closing Soon

### Market: ${market.market}
- Closes in: ${((new Date(market.closesAt).getTime() - Date.now()) / (1000 * 60 * 60)).toFixed(1)} hours
- Linked Hypothesis: ${hyp.id}
- Hypothesis Confidence: ${(hyp.confidence * 100).toFixed(0)}%

### Hypothesis: ${hyp.statement.slice(0, 200)}...

### Your Task
Time-sensitive decision required:
1. **Trade**: Execute trade before market closes
2. **Pass**: Explain why not trading
3. **Gather data**: Final check before decision

If trading: \`import { executePaperTrade } from './lib/trading';\`
`.trim();
}

function buildStuckHypothesisPrompt(hyp: any, stuckIn: string): string {
  return `
## 🟡 Stuck Hypothesis: ${hyp.id}

### Statement: ${hyp.statement.slice(0, 200)}...
- Status: ${stuckIn} for ${((Date.now() - new Date(hyp.updatedAt || hyp.createdAt).getTime()) / (1000 * 60 * 60)).toFixed(0)}h
- Confidence: ${(hyp.confidence * 100).toFixed(0)}%
- Evidence: ${hyp.evidence?.length || 0} observations

### Your Task
Hypothesis stuck in "${stuckIn}". You must:
1. **Activate**: Move to testing (requires entry rules)
2. **Kill**: Invalidate with reason
3. **Block**: Mark as blocked + create handoff for capability needed

Import: \`import { transitionHypothesis } from './lib/hypothesis';\`
`.trim();
}

function buildLowConfidencePrompt(hyp: any): string {
  return `
## 🟡 Low Confidence Hypothesis: ${hyp.id}

### Statement: ${hyp.statement.slice(0, 200)}...
- Confidence: ${(hyp.confidence * 100).toFixed(0)}% (below 30% threshold)
- Evidence: ${hyp.evidence?.length || 0} observations

### Recent Evidence
${(hyp.evidence || []).slice(-3).map((e: any) =>
  `- ${e.date}: ${e.observation.slice(0, 100)}... (${e.supports ? 'supports' : 'contradicts'})`
).join('\n')}

### Your Task
Low confidence suggests hypothesis may be invalid. Decide:
1. **Invalidate**: Evidence contradicts thesis
2. **Continue**: Need more data (explain what)
3. **Pivot**: Modify hypothesis based on learnings

Import: \`import { transitionHypothesis, addEvidence } from './lib/hypothesis';\`
`.trim();
}

function buildVelocityPrompt(tradesLast7Days: number): string {
  return `
## 🟡 Execution Velocity Warning

### Status
- Trades last 7 days: ${tradesLast7Days}
- Target: ${CONFIG.minTradesPerWeek}+

### Your Task
Trade velocity is low. Paper money is free - we learn from trades, not research.

1. **Review hypotheses**: Which can be traded TODAY?
2. **Execute small trades**: $20-50 per trade is fine
3. **Prioritize breadth**: Better to test 5 hypotheses shallowly than 1 deeply

Import: \`import { executePaperTrade, getPortfolioSummary } from './lib/trading';\`

Constraints: Auto-approved up to $50, notify up to $200, approval required above $200.
`.trim();
}

// ============================================================================
// Execution Metrics
// ============================================================================

export interface ExecutionMetrics {
  tradesLast7Days: number;
  tradesLast30Days: number;
  avgDaysFromProposedToTrade: number | null;
  hypothesesWithTrades: number;
  hypothesesWithoutTrades: number;
  velocityScore: 'healthy' | 'warning' | 'critical';
}

export function getExecutionMetrics(): ExecutionMetrics {
  try {
    const portfolio = loadPortfolio();
    const hypotheses = JSON.parse(fs.readFileSync(HYPOTHESES_FILE, 'utf-8')).hypotheses || [];

    const now = Date.now();
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const monthAgo = now - 30 * 24 * 60 * 60 * 1000;

    const tradesLast7Days = portfolio.tradeHistory.filter(
      (t: any) => new Date(t.timestamp).getTime() > weekAgo
    ).length;

    const tradesLast30Days = portfolio.tradeHistory.filter(
      (t: any) => new Date(t.timestamp).getTime() > monthAgo
    ).length;

    const hypothesesWithTrades = hypotheses.filter((h: any) => h.linkedTrade).length;
    const hypothesesWithoutTrades = hypotheses.filter(
      (h: any) => ['proposed', 'testing'].includes(h.status) && !h.linkedTrade
    ).length;

    let velocityScore: 'healthy' | 'warning' | 'critical' = 'healthy';
    if (tradesLast7Days === 0) {
      velocityScore = 'critical';
    } else if (tradesLast7Days < CONFIG.minTradesPerWeek) {
      velocityScore = 'warning';
    }

    return {
      tradesLast7Days,
      tradesLast30Days,
      avgDaysFromProposedToTrade: null, // TODO: calculate
      hypothesesWithTrades,
      hypothesesWithoutTrades,
      velocityScore,
    };
  } catch (error) {
    return {
      tradesLast7Days: 0,
      tradesLast30Days: 0,
      avgDaysFromProposedToTrade: null,
      hypothesesWithTrades: 0,
      hypothesesWithoutTrades: 0,
      velocityScore: 'critical',
    };
  }
}
