# System Refactor Plan: Code vs Intelligence Split

## Goal
Reduce cognitive overhead on models by moving procedural/deterministic logic to code, reserving model intelligence for judgment and reasoning.

## Design Principles

### Code Should Handle:
- **Validation** - Position limits, cash reserves, trade constraints
- **State transitions** - Moving hypothesis from proposed→testing, trade execution
- **Data gathering** - Fetching prices, market data, portfolio state
- **Formatting** - Preparing context for models in digestible chunks
- **Gating** - Auto-approve vs require-approval decisions
- **Scheduling** - When to run what, event triggers

### Models Should Handle:
- **Judgment** - Is this hypothesis worth testing? Should we exit this position?
- **Prioritization** - What matters most right now?
- **Interpretation** - What does this price movement mean?
- **Strategy** - How should we approach this market?
- **Communication** - Explaining decisions to the CEO

---

## Phase 1: Trading Execution Library (Code)

### Create `lib/trading.ts`

```typescript
interface TradeParams {
  market: string;
  direction: 'YES' | 'NO';
  amount: number;  // USD
  hypothesisId: string;
  rationale: string;
  exitCriteria: ExitCriteria;
}

interface TradeResult {
  success: boolean;
  tradeId?: string;
  error?: string;
  requiresApproval?: boolean;
  approvalId?: string;
}

// Code handles ALL validation - models don't need to remember rules
export async function executePaperTrade(params: TradeParams): Promise<TradeResult> {
  // 1. Load portfolio
  const portfolio = loadPortfolio();

  // 2. VALIDATE (code enforces, not model)
  const validation = validateTrade(params, portfolio);
  if (!validation.valid) {
    return { success: false, error: validation.error };
  }

  // 3. CHECK APPROVAL TIER (code decides)
  const tier = getApprovalTier(params);
  if (tier === 'approve') {
    const approvalId = await createApproval(params);
    return { success: false, requiresApproval: true, approvalId };
  }

  // 4. EXECUTE (code does state transition)
  const trade = await createTrade(params, portfolio);

  // 5. NOTIFY (code handles communication)
  if (tier === 'notify') {
    await sendTelegramAlert(`📈 Executed: ${trade.summary}`);
  }

  return { success: true, tradeId: trade.id };
}

function validateTrade(params: TradeParams, portfolio: Portfolio): ValidationResult {
  // Max 20% in single market
  const marketExposure = getMarketExposure(portfolio, params.market);
  if ((marketExposure + params.amount) / portfolio.totalValue > 0.20) {
    return { valid: false, error: 'Would exceed 20% single market limit' };
  }

  // Max 10 concurrent positions
  if (portfolio.positions.length >= 10 && !hasExistingPosition(portfolio, params.market)) {
    return { valid: false, error: 'Already at 10 position limit' };
  }

  // 20% cash reserve
  const minCash = portfolio.startingCapital * 0.20;
  if (portfolio.cash - params.amount < minCash) {
    return { valid: false, error: `Would breach ${minCash} cash reserve` };
  }

  return { valid: true };
}

function getApprovalTier(params: TradeParams): 'auto' | 'notify' | 'approve' {
  if (params.amount <= 50) return 'auto';
  if (params.amount <= 200) return 'notify';
  return 'approve';
}
```

### Model's new job (simplified prompt):

```markdown
## Trading

When you want to execute a trade, call the trading library:

```typescript
import { executePaperTrade } from './lib/trading';

const result = await executePaperTrade({
  market: 'largest-company-end-of-2025',
  direction: 'YES',
  amount: 50,
  hypothesisId: 'hyp-005',
  rationale: 'Testing volatility mispricing hypothesis',
  exitCriteria: { takeProfit: 0.20, stopLoss: 0.04 }
});

if (result.requiresApproval) {
  // Trade queued for CEO approval
} else if (result.success) {
  // Trade executed
} else {
  // Validation failed: result.error
}
```

You don't need to check position limits or cash reserves - the library handles that.
Focus on: Should we make this trade? What's the rationale?
```

---

## Phase 2: Hypothesis State Machine (Code)

### Create `lib/hypothesis.ts`

```typescript
type HypothesisStatus = 'proposed' | 'testing' | 'validated' | 'invalidated' | 'blocked';

interface HypothesisTransition {
  from: HypothesisStatus;
  to: HypothesisStatus;
  requires: string[];  // What must be true
  actions: string[];   // What code does automatically
}

const TRANSITIONS: HypothesisTransition[] = [
  {
    from: 'proposed',
    to: 'testing',
    requires: ['hasTestMethod', 'hasEntryRules', 'hasExitRules'],
    actions: ['setTestStartedAt', 'notifyTelegram']
  },
  {
    from: 'testing',
    to: 'validated',
    requires: ['confidence > 0.55', 'trades >= minSampleSize', 'winRate > 0.50'],
    actions: ['createStrategy', 'notifyTelegram', 'logLearning']
  },
  {
    from: 'testing',
    to: 'invalidated',
    requires: ['confidence < 0.35', 'OR', 'trades >= minSampleSize && winRate < 0.40'],
    actions: ['archiveHypothesis', 'notifyTelegram', 'logLearning']
  }
];

// Code enforces valid transitions
export function transitionHypothesis(
  hypothesisId: string,
  targetStatus: HypothesisStatus,
  reason: string
): TransitionResult {
  const hypothesis = loadHypothesis(hypothesisId);
  const transition = findTransition(hypothesis.status, targetStatus);

  if (!transition) {
    return { success: false, error: `Cannot go from ${hypothesis.status} to ${targetStatus}` };
  }

  // Check requirements
  for (const req of transition.requires) {
    if (!checkRequirement(hypothesis, req)) {
      return { success: false, error: `Requirement not met: ${req}` };
    }
  }

  // Execute actions
  for (const action of transition.actions) {
    executeAction(hypothesis, action);
  }

  // Update status
  hypothesis.status = targetStatus;
  hypothesis.statusReason = reason;
  hypothesis.updatedAt = new Date().toISOString();
  saveHypothesis(hypothesis);

  return { success: true };
}

// Code calculates confidence updates
export function addEvidence(
  hypothesisId: string,
  observation: string,
  supports: boolean | null,
  impact: number
): void {
  const hypothesis = loadHypothesis(hypothesisId);

  hypothesis.evidence.push({
    date: new Date().toISOString(),
    observation,
    supports,
    confidenceImpact: impact
  });

  // Code does the math
  hypothesis.confidence = Math.max(0, Math.min(1, hypothesis.confidence + impact));

  // Code checks for auto-transitions
  if (hypothesis.status === 'testing') {
    if (hypothesis.confidence < 0.30) {
      transitionHypothesis(hypothesisId, 'invalidated', 'Confidence dropped below 0.30');
    } else if (hypothesis.confidence > 0.70 && meetsValidationCriteria(hypothesis)) {
      transitionHypothesis(hypothesisId, 'validated', 'Confidence exceeded 0.70 with sufficient evidence');
    }
  }

  saveHypothesis(hypothesis);
}
```

### Model's new job:

```markdown
## Hypotheses

To update a hypothesis:

```typescript
import { addEvidence, transitionHypothesis } from './lib/hypothesis';

// Add evidence (code handles confidence calculation)
addEvidence('hyp-005',
  'AAPL dropped to 6.9¢, market pricing in NVDA momentum',
  false,  // supports hypothesis?
  -0.05   // your judgment on impact
);

// Transition status (code validates the transition is legal)
transitionHypothesis('hyp-005', 'invalidated',
  'Market efficiently prices momentum, not just fundamentals'
);
```

Focus on: What did we observe? Does it support the hypothesis? How much should this change our confidence?
Don't worry about: State file formats, validation rules, notifications.
```

---

## Phase 3: Strategic Orchestrator (Code + Light Model)

### Create `lib/orchestrator.ts`

```typescript
interface Priority {
  type: 'portfolio-risk' | 'time-sensitive' | 'blocked-hypothesis' | 'scheduled';
  urgency: number;  // 0-100
  action: string;
  context: any;
}

// Code gathers all the signals
export function getPriorities(): Priority[] {
  const priorities: Priority[] = [];

  // Portfolio risk (CODE checks)
  const portfolio = loadPortfolio();
  for (const position of portfolio.positions) {
    const pnlPct = (position.currentPrice - position.entryPrice) / position.entryPrice;
    if (pnlPct < -0.15) {
      priorities.push({
        type: 'portfolio-risk',
        urgency: 90,
        action: 'review-position',
        context: { positionId: position.id, pnlPct }
      });
    }
    if (position.currentPrice <= position.exitCriteria.stopLoss * 1.1) {
      priorities.push({
        type: 'portfolio-risk',
        urgency: 95,
        action: 'stop-loss-warning',
        context: { positionId: position.id, currentPrice: position.currentPrice }
      });
    }
  }

  // Time-sensitive (CODE checks)
  const closingSoon = getMarketsClosingWithin(24);
  for (const market of closingSoon) {
    if (hasHypothesisFor(market)) {
      priorities.push({
        type: 'time-sensitive',
        urgency: 80,
        action: 'closing-market-decision',
        context: { market, hoursRemaining: market.hoursToClose }
      });
    }
  }

  // Stuck hypotheses (CODE checks)
  const stuck = getHypothesesStuckOver(48);
  for (const hyp of stuck) {
    priorities.push({
      type: 'blocked-hypothesis',
      urgency: 60,
      action: 'unstick-hypothesis',
      context: { hypothesisId: hyp.id, hoursStuck: hyp.hoursInCurrentStatus }
    });
  }

  return priorities.sort((a, b) => b.urgency - a.urgency);
}

// Code prepares focused context for model
export function prepareDecisionContext(priority: Priority): string {
  switch (priority.action) {
    case 'review-position':
      return preparePositionReviewContext(priority.context.positionId);
    case 'closing-market-decision':
      return prepareClosingMarketContext(priority.context.market);
    // etc
  }
}
```

### Daemon integration:

```typescript
// In daemon.ts tick()
const priorities = getPriorities();

if (priorities.length > 0 && priorities[0].urgency > 70) {
  // High urgency - spawn focused model with minimal context
  const context = prepareDecisionContext(priorities[0]);
  await spawnFocusedAgent(priorities[0].action, context);
} else {
  // Normal flow - check scheduled responsibilities
  const dueResponsibility = getNextDueResponsibility();
  // ...
}
```

---

## Phase 4: Slim Down Agent Prompts

### Current Trade Research Engineer: 176 lines
### Target: ~50 lines

**Remove from prompt:**
- Position limit rules (now in lib/trading.ts)
- Hypothesis state machine (now in lib/hypothesis.ts)
- State file schemas (code handles)
- Communication protocols (code handles)

**Keep in prompt:**
- Identity and mission (10 lines)
- What judgment calls to make (20 lines)
- How to use the libraries (15 lines)
- What to report back (5 lines)

### New prompt structure:

```markdown
# Trade Research Engineer

You analyze Polymarket prediction markets and make trading decisions.

## Your Job
1. **Evaluate opportunities** - Is this market mispriced? Why?
2. **Decide on trades** - Should we buy/sell? How much confidence?
3. **Interpret results** - What does this outcome teach us?

## Available Tools

```typescript
// Trading (validation handled for you)
import { executePaperTrade, getPortfolioSummary } from './lib/trading';

// Hypotheses (state machine handled for you)
import { addEvidence, transitionHypothesis, getActiveHypotheses } from './lib/hypothesis';

// Market data (fetching handled for you)
import { getMarketPrice, getMarketDetails, getClosingSoonMarkets } from './lib/markets';
```

## Current Focus
[INJECTED BY ORCHESTRATOR - specific task with minimal context]

## Output
Return your decision and reasoning. The libraries handle execution.
```

---

## Phase 5: Context Injection (Code)

### Problem: Models get entire state files when they only need a slice

### Solution: Code prepares focused context

```typescript
// lib/context.ts

export function prepareHypothesisHealthContext(): string {
  const hypotheses = loadHypotheses();

  // Only include what's needed for this task
  const needsAttention = hypotheses.filter(h =>
    (h.status === 'proposed' && hoursOld(h) > 48) ||
    (h.status === 'testing' && h.confidence < 0.35) ||
    (h.status === 'testing' && h.confidence > 0.65)
  );

  return `
## Hypotheses Needing Attention (${needsAttention.length})

${needsAttention.map(h => `
### ${h.id}: ${h.statement.slice(0, 100)}...
- Status: ${h.status} (${hoursOld(h)}h)
- Confidence: ${(h.confidence * 100).toFixed(0)}%
- Evidence: ${h.evidence.length} observations
- Issue: ${diagnoseIssue(h)}
`).join('\n')}

## Your Task
For each hypothesis above, decide:
1. Activate (move to testing)
2. Kill (invalidate with reason)
3. Wait (explain what you're waiting for)
`;
}

export function preparePortfolioReviewContext(): string {
  const portfolio = loadPortfolio();

  return `
## Portfolio Status
- Cash: $${portfolio.cash.toFixed(2)}
- Positions: ${portfolio.positions.length}

${portfolio.positions.map(p => `
### ${p.market}
- Entry: ${p.entryPrice}¢ → Current: ${p.currentPrice}¢
- P&L: ${p.pnlPct > 0 ? '+' : ''}${(p.pnlPct * 100).toFixed(1)}% ($${p.unrealizedPnL.toFixed(2)})
- Exit triggers: TP ${p.exitCriteria.takeProfit}¢ / SL ${p.exitCriteria.stopLoss}¢
- Days held: ${daysSince(p.entryDate)}
`).join('\n')}

## Your Task
For each position:
1. Hold (explain why)
2. Exit (call executeTrade with direction opposite to entry)
3. Adjust (modify exit criteria)
`;
}
```

---

## Implementation Order

1. **lib/trading.ts** - Immediate impact on execution velocity
2. **lib/orchestrator.ts** - Adds strategic layer
3. **lib/hypothesis.ts** - Reduces state management bugs
4. **lib/context.ts** - Reduces context window waste
5. **Slim prompts** - After libraries are stable

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Trades per week | 1 | 10+ |
| Agent prompt length | 176 lines | <50 lines |
| Context per spawn | Full state files | Focused slice |
| Validation errors | Unknown | 0 (code prevents) |
| Model decisions per spawn | 5-10 | 1-3 (focused) |
