/**
 * Context Preparation Library
 *
 * Prepares focused, minimal context for model spawning.
 * Instead of loading entire state files, this module extracts
 * only what's relevant for the specific task.
 *
 * This reduces context window usage and keeps models focused.
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadPortfolio, getPortfolioSummary } from './trading';
import { loadHypotheses, getHypothesisSummary, Hypothesis } from './hypothesis';
import { getExecutionMetrics, getPriorityReport } from './orchestrator';

const STATE_DIR = path.join(__dirname, '..', 'state');

// ============================================================================
// Responsibility Contexts
// ============================================================================

/**
 * Context for hypothesis-health responsibility.
 * Only includes hypotheses that need attention.
 */
export function prepareHypothesisHealthContext(): string {
  const hypotheses = loadHypotheses();
  const now = Date.now();

  const needsAttention = hypotheses.filter(h => {
    if (!['proposed', 'testing'].includes(h.status)) return false;

    // Stuck in proposed > 48h
    if (h.status === 'proposed') {
      const hoursOld = (now - new Date(h.updatedAt).getTime()) / (1000 * 60 * 60);
      if (hoursOld > 48) return true;
    }

    // Low confidence while testing
    if (h.status === 'testing' && h.confidence < 0.35) return true;

    // High confidence, might be ready to validate
    if (h.status === 'testing' && h.confidence > 0.60) return true;

    return false;
  });

  if (needsAttention.length === 0) {
    return `
## Hypothesis Health Check

✅ No hypotheses need immediate attention.

Current status:
${getHypothesisSummary()}

If all looks good, you can end this session.
    `.trim();
  }

  return `
## Hypothesis Health Check

${needsAttention.length} hypotheses need your attention:

${needsAttention.map(h => formatHypothesisForReview(h)).join('\n\n---\n\n')}

## Your Task

For EACH hypothesis above, decide ONE of:
1. **Activate** → \`transitionHypothesis('${needsAttention[0]?.id}', 'testing', 'reason')\`
2. **Kill** → \`transitionHypothesis('${needsAttention[0]?.id}', 'invalidated', 'reason')\`
3. **Block** → \`blockHypothesis('${needsAttention[0]?.id}', 'capability needed')\`
4. **Wait** → Add evidence explaining what you're waiting for

Import: \`import { transitionHypothesis, blockHypothesis, addEvidence } from './lib/hypothesis';\`
  `.trim();
}

/**
 * Context for portfolio-review responsibility.
 */
export function preparePortfolioReviewContext(): string {
  const portfolio = loadPortfolio();

  if (portfolio.positions.length === 0) {
    return `
## Portfolio Review

No open positions.

${getPortfolioSummary()}

Consider: Are there hypotheses ready to trade?
    `.trim();
  }

  return `
## Portfolio Review

${getPortfolioSummary()}

## Position Analysis

${portfolio.positions.map(p => formatPositionForReview(p)).join('\n\n---\n\n')}

## Your Task

For EACH position:
1. **Hold** → Explain why the thesis is still valid
2. **Exit** → \`exitPosition('${portfolio.positions[0]?.id}', currentPrice, 'reason')\`
3. **Adjust** → Modify exit criteria if thesis changed

Import: \`import { exitPosition } from './lib/trading';\`
  `.trim();
}

/**
 * Context for market-scan responsibility.
 */
export function prepareMarketScanContext(): string {
  const metrics = getExecutionMetrics();
  const hypotheses = loadHypotheses();

  const testingCount = hypotheses.filter(h => h.status === 'testing').length;
  const proposedCount = hypotheses.filter(h => h.status === 'proposed').length;

  return `
## Market Scan

### Current State
- Hypotheses testing: ${testingCount}
- Hypotheses proposed: ${proposedCount}
- Trades last 7 days: ${metrics.tradesLast7Days}
- Velocity: ${metrics.velocityScore}

### Your Task

1. **Find opportunities** - Use Polymarket MCP to scan markets
2. **Generate hypotheses** - Create new hypotheses for promising opportunities
3. **Prioritize tradeable** - Focus on hypotheses we can test NOW

### Tools Available
- \`mcp__polymarket__search_markets\` - Search by keyword
- \`mcp__polymarket__get_closing_soon_markets\` - Markets closing soon
- \`mcp__polymarket__get_trending_markets\` - High volume markets
- \`mcp__polymarket__get_crypto_markets\` - Crypto-related
- \`mcp__polymarket__get_sports_markets\` - Sports betting

### Creating Hypotheses
\`\`\`typescript
import { createHypothesis } from './lib/hypothesis';

createHypothesis({
  statement: 'Clear, testable claim',
  rationale: 'Why this might be true',
  testMethod: 'How to test it',
  entryRules: 'When to enter',
  exitRules: 'When to exit',
  expectedWinRate: 0.55,
  minSampleSize: 5,
});
\`\`\`
  `.trim();
}

/**
 * Context for strategy-review responsibility.
 */
export function prepareStrategyReviewContext(): string {
  const portfolio = loadPortfolio();
  const metrics = getExecutionMetrics();
  const hypotheses = loadHypotheses();

  const validated = hypotheses.filter(h => h.status === 'validated');
  const invalidated = hypotheses.filter(h => h.status === 'invalidated');

  return `
## Weekly Strategy Review

### Performance Summary
- Total Return: ${portfolio.metrics.totalReturnPct >= 0 ? '+' : ''}${portfolio.metrics.totalReturnPct.toFixed(2)}%
- Realized P&L: $${portfolio.metrics.realizedPnL.toFixed(2)}
- Win Rate: ${(portfolio.metrics.winRate * 100).toFixed(0)}% (${portfolio.metrics.winCount}W/${portfolio.metrics.lossCount}L)

### Execution Velocity
- Trades last 7 days: ${metrics.tradesLast7Days}
- Trades last 30 days: ${metrics.tradesLast30Days}
- Velocity score: ${metrics.velocityScore}

### Hypothesis Outcomes
- Validated: ${validated.length}
- Invalidated: ${invalidated.length}

### Recent Validated Hypotheses
${validated.slice(-3).map(h => `- ${h.id}: ${h.statement.slice(0, 80)}...`).join('\n') || '(none)'}

### Recent Invalidated Hypotheses
${invalidated.slice(-3).map(h => `- ${h.id}: ${h.conclusion?.slice(0, 80) || h.statement.slice(0, 80)}...`).join('\n') || '(none)'}

### Your Task

1. **What's working?** - Identify patterns in wins
2. **What's not?** - Identify patterns in losses
3. **Adjust strategy** - Update approach based on learnings
4. **Log insights** - Add key learnings to learnings.json

Write a brief strategy memo (200 words max) summarizing findings.
  `.trim();
}

/**
 * Context for learning-synthesis responsibility.
 */
export function prepareLearningsSynthesisContext(): string {
  const learningsFile = path.join(STATE_DIR, 'trading/learnings.json');

  try {
    const learnings = JSON.parse(fs.readFileSync(learningsFile, 'utf-8'));
    const recent = (learnings.insights || []).slice(-10);

    return `
## Weekly Learning Synthesis

### Recent Learnings (${recent.length})

${recent.map((l: any) => `
**${l.title}** (${l.createdAt?.split('T')[0] || 'unknown'})
Category: ${l.category}
${l.content.slice(0, 200)}...
`).join('\n---\n')}

### Your Task

1. **Find patterns** - What themes repeat across learnings?
2. **Consolidate** - Merge similar insights
3. **Extract meta-insights** - What are we learning about learning?
4. **Identify gaps** - What should we be learning that we're not?

Write a synthesis (300 words max) with actionable takeaways.
    `.trim();
  } catch {
    return `
## Weekly Learning Synthesis

No learnings found. Focus on generating learnings through trades and hypothesis testing.
    `.trim();
  }
}

// ============================================================================
// Focused Task Contexts
// ============================================================================

/**
 * Minimal context for executing a specific trade.
 */
export function prepareTradeExecutionContext(
  hypothesisId: string,
  market: string,
  direction: 'YES' | 'NO'
): string {
  const hypothesis = loadHypotheses().find(h => h.id === hypothesisId);
  const portfolio = loadPortfolio();

  return `
## Trade Execution

### Hypothesis: ${hypothesisId}
${hypothesis?.statement || 'Unknown'}

### Trade
- Market: ${market}
- Direction: ${direction}
- Available cash: $${portfolio.cash.toFixed(2)}

### Constraints
- Auto-approve: ≤$50
- Notify: ≤$200
- Require approval: >$200

### Execute

\`\`\`typescript
import { executePaperTrade } from './lib/trading';

const result = await executePaperTrade({
  market: '${market}',
  direction: '${direction}',
  amount: 50,  // Your choice
  price: 0.XX, // Fetch current price
  hypothesisId: '${hypothesisId}',
  rationale: 'Your reasoning',
  exitCriteria: {
    takeProfit: 0.XX,
    stopLoss: 0.XX,
  }
});
\`\`\`
  `.trim();
}

/**
 * Context for making a position exit decision.
 */
export function prepareExitDecisionContext(positionId: string): string {
  const portfolio = loadPortfolio();
  const position = portfolio.positions.find(p => p.id === positionId);

  if (!position) {
    return `Position ${positionId} not found.`;
  }

  return `
## Exit Decision: ${position.market}

${formatPositionForReview(position)}

### Your Decision

Should we exit this position?

If YES:
\`\`\`typescript
import { exitPosition } from './lib/trading';
await exitPosition('${positionId}', ${position.currentPrice}, 'your reason');
\`\`\`

If NO, explain why the thesis is still valid.
  `.trim();
}

// ============================================================================
// Status Contexts (for /status command, daily briefings)
// ============================================================================

/**
 * Full status for CEO briefing.
 */
export function prepareCEOBriefingContext(): string {
  const portfolio = loadPortfolio();
  const metrics = getExecutionMetrics();
  const priorities = getPriorityReport();

  return `
## Daily CEO Briefing

### Portfolio
- Cash: $${portfolio.cash.toFixed(2)}
- Positions: ${portfolio.positions.length}
- Total Return: ${portfolio.metrics.totalReturn >= 0 ? '+' : ''}$${portfolio.metrics.totalReturn.toFixed(2)} (${portfolio.metrics.totalReturnPct >= 0 ? '+' : ''}${portfolio.metrics.totalReturnPct.toFixed(2)}%)

### Execution
- Trades (7d): ${metrics.tradesLast7Days}
- Velocity: ${metrics.velocityScore}

### Priorities
${priorities}

### Positions
${portfolio.positions.map(p => {
  const pnlPct = ((p.currentPrice - p.entryPrice) / p.entryPrice * 100).toFixed(1);
  return `- ${p.outcome || p.market}: ${pnlPct}% ($${p.unrealizedPnL.toFixed(2)})`;
}).join('\n') || '(no positions)'}
  `.trim();
}

/**
 * Compact status for quick checks.
 */
export function prepareQuickStatusContext(): string {
  const portfolio = loadPortfolio();
  const metrics = getExecutionMetrics();
  const hypotheses = loadHypotheses();

  return `
P&L: ${portfolio.metrics.totalReturn >= 0 ? '+' : ''}$${portfolio.metrics.totalReturn.toFixed(2)} | ` +
    `Cash: $${portfolio.cash.toFixed(2)} | ` +
    `Positions: ${portfolio.positions.length} | ` +
    `Trades (7d): ${metrics.tradesLast7Days} | ` +
    `Hypotheses: ${hypotheses.filter(h => h.status === 'testing').length} testing`;
}

// ============================================================================
// Helper Functions
// ============================================================================

function formatHypothesisForReview(h: Hypothesis): string {
  const hoursOld = (Date.now() - new Date(h.updatedAt).getTime()) / (1000 * 60 * 60);

  return `
### ${h.id}: ${h.statement}

- **Status:** ${h.status} (${hoursOld.toFixed(0)}h since last update)
- **Confidence:** ${(h.confidence * 100).toFixed(0)}%
- **Evidence:** ${h.evidence.length} observations
- **Source:** ${h.source || 'manual'}

**Rationale:** ${h.rationale.slice(0, 200)}...

**Test Method:** ${h.testMethod.slice(0, 200)}...

${h.evidence.length > 0 ? `
**Recent Evidence:**
${h.evidence.slice(-2).map(e =>
  `- ${e.date.split('T')[0]}: ${e.observation.slice(0, 100)}... (${e.supports === true ? '✓' : e.supports === false ? '✗' : '?'})`
).join('\n')}
` : ''}
  `.trim();
}

function formatPositionForReview(p: any): string {
  const pnlPct = ((p.currentPrice - p.entryPrice) / p.entryPrice * 100).toFixed(1);
  const daysSinceEntry = Math.floor((Date.now() - new Date(p.entryDate).getTime()) / (1000 * 60 * 60 * 24));

  return `
### ${p.outcome || p.market}

- **Direction:** ${p.direction}
- **Entry:** ${(p.entryPrice * 100).toFixed(1)}¢ (${daysSinceEntry}d ago)
- **Current:** ${(p.currentPrice * 100).toFixed(1)}¢
- **P&L:** ${pnlPct}% ($${p.unrealizedPnL.toFixed(2)})
- **Shares:** ${p.shares}
- **Exit Criteria:** TP ${(p.exitCriteria.takeProfit * 100).toFixed(1)}¢ / SL ${(p.exitCriteria.stopLoss * 100).toFixed(1)}¢
- **Hypothesis:** ${p.hypothesisId}

**Original Rationale:** ${p.rationale.slice(0, 200)}...
  `.trim();
}

// ============================================================================
// Agent-Specific Context Builders
// ============================================================================

/**
 * Build minimal context for Trade Research Engineer.
 */
export function buildTradeResearchContext(responsibility: string): string {
  switch (responsibility) {
    case 'hypothesis-health':
      return prepareHypothesisHealthContext();
    case 'portfolio-review':
      return preparePortfolioReviewContext();
    case 'market-scan':
      return prepareMarketScanContext();
    case 'strategy-review':
      return prepareStrategyReviewContext();
    case 'learning-synthesis':
      return prepareLearningsSynthesisContext();
    default:
      return `Unknown responsibility: ${responsibility}`;
  }
}

/**
 * Build minimal context for Agent Engineer.
 */
export function buildAgentEngineerContext(responsibility: string): string {
  switch (responsibility) {
    case 'idea-triage':
      return prepareIdeaTriageContext();
    case 'build-sprint':
      return prepareBuildSprintContext();
    case 'system-health':
      return prepareSystemHealthContext();
    default:
      return `Unknown responsibility: ${responsibility}`;
  }
}

function prepareIdeaTriageContext(): string {
  const ideasFile = path.join(STATE_DIR, 'improvements/ideas.json');

  try {
    const ideas = JSON.parse(fs.readFileSync(ideasFile, 'utf-8'));
    const backlog = ideas.backlog || [];
    const untriaged = backlog.filter((i: any) => i.status === 'proposed');

    if (untriaged.length === 0) {
      return `
## Idea Triage

No untriaged ideas. Current backlog:
${backlog.slice(0, 5).map((i: any) => `- [${i.priority}] ${i.title}`).join('\n') || '(empty)'}
      `.trim();
    }

    return `
## Idea Triage

${untriaged.length} ideas need triage:

${untriaged.map((i: any) => `
### ${i.id}: ${i.title}
Category: ${i.category}
Rationale: ${i.rationale.slice(0, 200)}...
`).join('\n---\n')}

### Your Task

For each idea, assess:
1. **Leverage** - How much will this help? (high/medium/low)
2. **Effort** - How long to build? (high/medium/low)
3. **Priority** - Based on leverage/effort ratio

Update each idea with your assessment and set status to 'triaged'.
    `.trim();
  } catch {
    return 'Failed to load ideas.json';
  }
}

function prepareBuildSprintContext(): string {
  const ideasFile = path.join(STATE_DIR, 'improvements/ideas.json');

  try {
    const ideas = JSON.parse(fs.readFileSync(ideasFile, 'utf-8'));
    const backlog = ideas.backlog || [];
    const triaged = backlog.filter((i: any) => i.status === 'triaged').sort((a: any, b: any) => a.priority - b.priority);

    if (triaged.length === 0) {
      return 'No triaged ideas to build. Run idea-triage first.';
    }

    const topIdea = triaged[0];

    return `
## Build Sprint

### Top Priority: ${topIdea.id}
**${topIdea.title}**

Category: ${topIdea.category}
Leverage: ${topIdea.leverage}
Effort: ${topIdea.effort}

Rationale: ${topIdea.rationale}

${topIdea.triageNotes ? `Triage Notes: ${topIdea.triageNotes}` : ''}

### Your Task

Implement this improvement. When done:
1. Move to \`completed\` array in ideas.json
2. Add \`outcome\` describing what was built
3. Update \`capabilities.json\` if new capability

### Other Triaged Ideas (${triaged.length - 1})
${triaged.slice(1, 4).map((i: any) => `- ${i.title}`).join('\n') || '(none)'}
    `.trim();
  } catch {
    return 'Failed to load ideas.json';
  }
}

function prepareSystemHealthContext(): string {
  const healthFile = path.join(STATE_DIR, 'agent-engineering/health.json');

  try {
    const health = JSON.parse(fs.readFileSync(healthFile, 'utf-8'));

    return `
## System Health Check

Last check: ${health.lastCheck || 'never'}

### Services
${Object.entries(health.services || {}).map(([name, status]) => `- ${name}: ${status}`).join('\n') || '(no services tracked)'}

### Recent Errors
${(health.recentErrors || []).slice(-5).map((e: any) => `- ${e.timestamp}: ${e.message}`).join('\n') || '(none)'}

### Your Task

1. Check daemon is running
2. Check telegram handler is responding
3. Review any errors
4. Update health.json with findings
    `.trim();
  } catch {
    return `
## System Health Check

health.json not found or invalid. Create it with current system status.
    `.trim();
  }
}
