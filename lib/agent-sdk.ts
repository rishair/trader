/**
 * Agent SDK Integration
 *
 * Core wrapper for the Claude Agent SDK, replacing spawn('claude', ...) calls.
 * Provides type-safe agent definitions and execution functions.
 */

import { query, type Options, type AgentDefinition, type SDKMessage, type Query } from '@anthropic-ai/claude-agent-sdk';
import * as path from 'path';

// Agent role types
export type AgentRole = 'trade-research' | 'agent-engineer';

// Agent definition registry
export const AGENTS: Record<string, AgentDefinition> = {
  'trade-research': {
    description: 'Trade Research Engineer - Analyzes Polymarket prediction markets and makes trading decisions',
    prompt: `You are the Trade Research Engineer.

## Your Job

1. **Evaluate opportunities** - Is this market mispriced? Why?
2. **Decide on trades** - Should we buy/sell? How confident?
3. **Interpret results** - What does this outcome teach us?

## Libraries (Use These!)

\`\`\`typescript
// Trading - validation, approval tiers, state all handled for you
import { executePaperTrade, exitPosition, getPortfolioSummary } from './lib/trading';

// Hypotheses - state machine handles transitions
import {
  transitionHypothesis,  // Move between proposed→testing→validated/invalidated
  addEvidence,           // Record observations, confidence auto-updates
  blockHypothesis,       // Block + create handoff for capability needed
  createHypothesis,      // Create new hypothesis
  getHypothesisSummary   // Get formatted summary
} from './lib/hypothesis';

// Handoffs - request capabilities from Agent Engineer
import { requestCapability, getHandoffsSummary } from './lib/handoffs';
\`\`\`

## Trade Execution

When you want to trade:
\`\`\`typescript
const result = await executePaperTrade({
  market: 'market-slug',
  direction: 'YES',
  amount: 50,              // $50 = auto-execute, $50-200 = notify, >$200 = approval
  price: 0.09,             // Entry price (0-1)
  hypothesisId: 'hyp-xxx',
  rationale: 'Why this trade',
  exitCriteria: {
    takeProfit: 0.20,      // Exit if price hits this
    stopLoss: 0.04,        // Exit if price drops to this
  }
});
\`\`\`

## When Blocked - Request Capabilities

If you need infrastructure that doesn't exist, create a handoff to Agent Engineer:
\`\`\`typescript
import { requestCapability } from './lib/handoffs';

// Request Agent Engineer to build something you need
requestCapability(
  'Need backtesting capability for momentum strategies',
  { hypothesisId: 'hyp-xxx', context: 'additional info' },
  'high'  // priority: low, medium, high
);
\`\`\`

The daemon will process handoffs automatically. You can check status with \`getHandoffsSummary()\`.

## Key Principles

- **Trade > Research** - One trade teaches more than ten analyses
- **Wrong fast > Right slow** - Paper money is free, learn quickly
- **Kill hypotheses ruthlessly** - Don't rationalize poor performance
- **Link everything** - Every trade needs a hypothesis ID
- **Ask for help** - If blocked, create a handoff instead of staying stuck`,
    tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    model: 'opus',
  },

  'agent-engineer': {
    description: 'Agent Engineer - Builds capabilities, fixes issues, improves the system',
    prompt: `You are the Agent Engineer.

## Your Job

1. **Build capabilities** - Create tools, fix bugs, improve infrastructure
2. **Fix issues** - Debug and resolve system problems
3. **Improve agents** - Update prompts, add features, optimize workflows

## Principles

- Build incrementally - small, working changes
- Test before deploying
- Document what you build
- Keep code simple and readable`,
    tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebFetch'],
    model: 'opus',
  },

  'market-watcher': {
    description: 'Monitors markets and tracks prices. Use for fetching current market data, tracking positions, and identifying opportunities.',
    prompt: `You are a market monitoring agent for an autonomous trading system.

## Mission

Fetch and process market data, track positions, and flag noteworthy changes.

## Capabilities

1. **Fetch prices** - Get current market prices from Polymarket or other sources
2. **Track positions** - Monitor open positions against current prices
3. **Calculate P&L** - Update unrealized gains/losses
4. **Alert on changes** - Flag significant price movements

## Output

When monitoring, update:
- state/portfolio.json with current prices and P&L
- state/status.md with notable changes

Flag in state/needs_attention.md if:
- Position moves >10% against us
- Market liquidity drops significantly
- Approaching position limits`,
    tools: ['Read', 'Write', 'WebFetch', 'Bash', 'Grep'],
    model: 'sonnet',
  },

  'hypothesis-tester': {
    description: 'Tests hypotheses by checking entry/exit conditions and executing trades',
    prompt: `You are a hypothesis testing agent.

## Mission

Check active hypotheses for entry/exit conditions and execute trades when criteria are met.

## Process

1. Load hypotheses with status='testing' from state/trading/hypotheses.json
2. For each hypothesis, check current market prices
3. If entry conditions met and not in position, consider entering
4. If in position, check exit conditions (take profit, stop loss)
5. Use lib/trading.ts to execute trades

## Key Rules

- Only trade hypotheses with confidence > 30%
- Follow position sizing rules
- Record all actions as evidence on the hypothesis`,
    tools: ['Read', 'Write', 'WebFetch', 'Bash', 'Grep'],
    model: 'sonnet',
  },

  'researcher': {
    description: 'Deep research agent for investigating trading strategies, market mechanics, and academic literature',
    prompt: `You are a research agent specializing in prediction markets and trading strategies.

## Mission

Conduct deep research on topics related to prediction markets, trading strategies, and market mechanics.

## Capabilities

1. **Web research** - Search and analyze online sources
2. **Data analysis** - Process market data and identify patterns
3. **Literature review** - Find relevant academic papers and articles
4. **Synthesis** - Combine findings into actionable insights

## Output

Save research findings to:
- state/trading/learnings.json for insights
- state/trading/hypotheses.json for new hypothesis ideas`,
    tools: ['Read', 'Write', 'WebFetch', 'WebSearch', 'Bash', 'Grep'],
    model: 'opus',
  },

  'strategy-tester': {
    description: 'Tests trading strategies through backtesting and paper trading',
    prompt: `You are a strategy testing agent.

## Mission

Validate trading strategies before deployment through backtesting and paper trading.

## Process

1. Load strategy parameters
2. Gather historical data
3. Run backtest simulation
4. Analyze results and report`,
    tools: ['Read', 'Write', 'Bash', 'Grep', 'Glob', 'WebFetch'],
    model: 'opus',
  },

  'resourcer': {
    description: 'Finds existing libraries, APIs, MCP servers, and tools before building new ones',
    prompt: `You are a resource discovery agent.

## Mission

Before building anything new, find existing solutions:
- Libraries and packages
- APIs and services
- MCP servers
- Tools and scripts

## Process

1. Search npm, GitHub, documentation
2. Evaluate quality and fit
3. Report findings with recommendations`,
    tools: ['Read', 'Write', 'WebSearch', 'WebFetch', 'Grep', 'Glob', 'Bash'],
    model: 'sonnet',
  },

  'tool-builder': {
    description: 'Creates new tools, scripts, and MCP servers',
    prompt: `You are a tool building agent.

## Mission

Create new tools when existing solutions don't meet needs.

## Principles

- Keep tools simple and focused
- Include error handling
- Document usage
- Test before deploying`,
    tools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob'],
    model: 'opus',
  },

  'self-improver': {
    description: 'Diagnoses and fixes infrastructure issues',
    prompt: `You are a self-improvement agent.

## Mission

Diagnose and fix issues with the trading system infrastructure.

## Capabilities

1. Analyze error logs
2. Debug failing components
3. Fix configuration issues
4. Update agent prompts`,
    tools: ['Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash'],
    model: 'opus',
  },

  'trade-executor': {
    description: 'Executes paper trades and manages positions',
    prompt: `You are a trade execution agent.

## Mission

Execute paper trades and manage positions following the trading system rules.

## Key Rules

- Use lib/trading.ts for all trades
- Follow approval tiers
- Update portfolio state
- Link trades to hypotheses`,
    tools: ['Read', 'Write', 'Bash'],
    model: 'sonnet',
  },
};

// Default options for all queries
const DEFAULT_OPTIONS: Partial<Options> = {
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,
  cwd: path.join(__dirname, '..'),
  settingSources: ['project'], // Load CLAUDE.md
};

/**
 * Execute a query using the Agent SDK
 *
 * @param prompt - The prompt to send to the agent
 * @param options - Additional options
 * @returns AsyncGenerator of SDK messages
 */
export function executeQuery(
  prompt: string,
  options: Partial<Options> = {}
): Query {
  return query({
    prompt,
    options: {
      ...DEFAULT_OPTIONS,
      agents: AGENTS,
      ...options,
    },
  });
}

/**
 * Execute a query and collect the final result
 *
 * @param prompt - The prompt to send
 * @param options - Additional options
 * @returns The final result text and execution info
 */
export async function executeAndWait(
  prompt: string,
  options: Partial<Options> = {}
): Promise<{
  result: string;
  success: boolean;
  costUsd: number;
  durationMs: number;
}> {
  const messages = executeQuery(prompt, options);

  let result = '';
  let success = false;
  let costUsd = 0;
  let durationMs = 0;

  for await (const message of messages) {
    if (message.type === 'result') {
      if (message.subtype === 'success') {
        result = message.result;
        success = true;
      } else {
        success = false;
        result = message.errors?.join('\n') || 'Unknown error';
      }
      costUsd = message.total_cost_usd;
      durationMs = message.duration_ms;
    }
  }

  return { result, success, costUsd, durationMs };
}

/**
 * Execute a query with streaming output to a callback
 *
 * @param prompt - The prompt to send
 * @param onMessage - Callback for each message
 * @param options - Additional options
 */
export async function executeWithStreaming(
  prompt: string,
  onMessage: (message: SDKMessage) => void,
  options: Partial<Options> = {}
): Promise<{
  result: string;
  success: boolean;
  costUsd: number;
  durationMs: number;
}> {
  const messages = executeQuery(prompt, {
    ...options,
    includePartialMessages: true,
  });

  let result = '';
  let success = false;
  let costUsd = 0;
  let durationMs = 0;

  for await (const message of messages) {
    onMessage(message);

    if (message.type === 'result') {
      if (message.subtype === 'success') {
        result = message.result;
        success = true;
      } else {
        success = false;
        result = message.errors?.join('\n') || 'Unknown error';
      }
      costUsd = message.total_cost_usd;
      durationMs = message.duration_ms;
    }
  }

  return { result, success, costUsd, durationMs };
}

/**
 * Resume a previous session
 *
 * @param sessionId - Session ID to resume
 * @param prompt - New prompt
 * @param options - Additional options
 */
export function resumeSession(
  sessionId: string,
  prompt: string,
  options: Partial<Options> = {}
): Query {
  return query({
    prompt,
    options: {
      ...DEFAULT_OPTIONS,
      agents: AGENTS,
      resume: sessionId,
      ...options,
    },
  });
}

/**
 * Execute an agent by role name
 *
 * @param role - The agent role
 * @param prompt - The prompt to send
 * @param options - Additional options
 */
export function executeAgentByRole(
  role: AgentRole,
  prompt: string,
  options: Partial<Options> = {}
): Query {
  const agentDef = AGENTS[role];
  if (!agentDef) {
    throw new Error(`Unknown agent role: ${role}`);
  }

  // Use the agent's model preference
  const modelMap: Record<string, string> = {
    'sonnet': 'claude-sonnet-4-5-20250929',
    'haiku': 'claude-haiku-4-5-20251001',
    'opus': 'claude-opus-4-20250514',
  };

  return query({
    prompt: `${agentDef.prompt}\n\n---\n\n${prompt}`,
    options: {
      ...DEFAULT_OPTIONS,
      agents: AGENTS,
      model: modelMap[agentDef.model || 'sonnet'],
      tools: agentDef.tools as string[],
      ...options,
    },
  });
}

/**
 * Collect output from a Query generator, returning the accumulated text
 */
export async function collectOutput(queryGen: Query): Promise<string> {
  let output = '';

  for await (const message of queryGen) {
    if (message.type === 'assistant' && message.message?.content) {
      for (const block of message.message.content) {
        if ('text' in block && block.text) {
          output = block.text;
        }
      }
    }
    if (message.type === 'result' && message.subtype === 'success') {
      output = message.result;
    }
  }

  return output;
}

// Export types
export type { Options, AgentDefinition, SDKMessage, Query };
