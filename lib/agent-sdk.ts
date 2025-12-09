/**
 * Agent SDK Integration
 *
 * Core wrapper for the Claude Agent SDK, replacing spawn('claude', ...) calls.
 * Provides type-safe agent definitions and execution functions.
 */

import { query, type Options, type AgentDefinition, type SDKMessage, type Query } from '@anthropic-ai/claude-agent-sdk';
import * as path from 'path';

// Import tool servers and tool lists
import { tradingToolsServer, TRADING_TOOLS } from './tools/trading';
import { hypothesisToolsServer, HYPOTHESIS_TOOLS } from './tools/hypothesis';
import { handoffToolsServer, HANDOFF_TOOLS } from './tools/handoffs';
import { libraryToolsServer, LIBRARY_TOOLS } from './tools/library';

// Combined tool servers for agent configuration
export const mcpServers = {
  trading: tradingToolsServer,
  hypothesis: hypothesisToolsServer,
  handoffs: handoffToolsServer,
  library: libraryToolsServer,
};

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

## Available Tools

You have access to trading system tools. Use them directly - no code needed.

### Trading Tools
- \`mcp__trading__execute_paper_trade\` - Execute a paper trade (handles validation, approval)
- \`mcp__trading__exit_position\` - Close an open position
- \`mcp__trading__validate_trade\` - Check if a trade would be valid
- \`mcp__trading__get_approval_tier\` - Check approval requirements for an amount
- \`mcp__trading__get_portfolio_summary\` - Get portfolio overview
- \`mcp__trading__check_exit_triggers\` - Find positions hitting TP/SL

### Hypothesis Tools
- \`mcp__hypothesis__create_hypothesis\` - Create a new hypothesis
- \`mcp__hypothesis__transition_hypothesis\` - Change hypothesis status
- \`mcp__hypothesis__add_evidence\` - Record an observation
- \`mcp__hypothesis__block_hypothesis\` - Block pending capability
- \`mcp__hypothesis__select_next_hypothesis\` - Pick the next hypothesis to work on
- \`mcp__hypothesis__get_hypothesis_summary\` - Get all hypotheses by status
- \`mcp__hypothesis__record_trade_result\` - Link trade outcome to hypothesis
- \`mcp__hypothesis__get_related_learnings\` - Find related past learnings
- \`mcp__hypothesis__has_trade_validation\` - Check if hypothesis is validated for >$50 trades
- \`mcp__hypothesis__link_market_to_hypothesis\` - Associate a market for testing

### Handoff Tools
- \`mcp__handoffs__request_capability\` - Ask Agent Engineer to build something
- \`mcp__handoffs__get_pending_handoffs\` - Check handoff queue
- \`mcp__handoffs__get_handoffs_summary\` - Get summary of all handoffs

### Library Tools (Knowledge Base)
- \`mcp__library__search\` - Search learnings by query and tags
- \`mcp__library__get_all_claims\` - Get all learning claims for quick context
- \`mcp__library__add\` - Add a new learning to the library
- \`mcp__library__find_contradictions\` - Find learnings that contradict a claim
- \`mcp__library__get\` - Get specific learning by ID
- \`mcp__library__update\` - Update an existing learning
- \`mcp__library__list\` - List learnings with filters

## Trade Execution

To execute a trade, use the execute_paper_trade tool:
- market: market slug (e.g., "will-bitcoin-reach-100k")
- direction: "YES" or "NO"
- amount: USD amount ($50 = auto, $50-200 = notify, >$200 = approval)
- price: entry price (0-1, e.g., 0.09 = 9 cents)
- hypothesisId: linked hypothesis
- rationale: why this trade
- exitCriteria: { takeProfit, stopLoss }

## When Blocked - Request Capabilities

If you need infrastructure, use the request_capability tool:
- description: what you need
- context: additional info
- priority: "low", "medium", or "high"

## When User Shares Content

User content is HIGH PRIORITY - but evaluate it seriously, not blindly accept.

**Step 1: Check existing knowledge (USE THESE TOOLS)**
- \`mcp__library__search\` - Search for related learnings
- \`mcp__library__find_contradictions\` - Check if claim conflicts with what we know
- \`mcp__hypothesis__get_hypothesis_summary\` - See related hypotheses

**Step 2: Be assertive based on results**
- If library search finds related learning → cite it, don't reinvent
- If find_contradictions returns results → push back with that data
- If nothing found → it's novel, evaluate if worth testing

**Step 3: Take action**
| Situation | Action |
|-----------|--------|
| We know this | Cite the learning ID, ask if they want to refine |
| Contradicts our data | Push back: "learning-xyz shows the opposite..." |
| Extends existing knowledge | \`mcp__library__update\` to add to the learning |
| Novel and testable | \`mcp__hypothesis__create_hypothesis\` with source: "ceo-shared" |
| Novel insight (not testable) | \`mcp__library__add\` as new learning |

**Always:**
- Lead with your assessment, not caveats
- Cite specific IDs: "learning-abc123 shows...", "hyp-002 tested..."
- If creating hypothesis: tell them \`/test <id>\` to start immediately

## Key Principles

- **Trade > Research** - One trade teaches more than ten analyses
- **Wrong fast > Right slow** - Paper money is free, learn quickly
- **Kill hypotheses ruthlessly** - Don't rationalize poor performance
- **Link everything** - Every trade needs a hypothesis ID
- **Ask for help** - If blocked, request capability instead of staying stuck
- **Be honest** - Push back on bad ideas, even from the CEO`,
    tools: [
      'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
      // Trading tools
      ...TRADING_TOOLS,
      // Hypothesis tools
      ...HYPOTHESIS_TOOLS,
      // Handoff tools
      ...HANDOFF_TOOLS,
    ],
    model: 'opus',
  },

  'agent-engineer': {
    description: 'Agent Engineer - Builds capabilities, fixes issues, improves the system',
    prompt: `You are the Agent Engineer.

## Your Job

1. **Build capabilities** - Create tools, fix bugs, improve infrastructure
2. **Fix issues** - Debug and resolve system problems
3. **Improve agents** - Update prompts, add features, optimize workflows

## Available Tools

### Handoff Tools
- \`mcp__handoffs__get_pending_handoffs\` - Check handoff queue for your role
- \`mcp__handoffs__get_handoffs_summary\` - Get summary of all handoffs

## Principles

- Build incrementally - small, working changes
- Test before deploying
- Document what you build
- Keep code simple and readable`,
    tools: [
      'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebFetch',
      // Handoff tools
      ...HANDOFF_TOOLS,
    ],
    model: 'opus',
  },

  'market-watcher': {
    description: 'Monitors markets and tracks prices. Use for fetching current market data, tracking positions, and identifying opportunities.',
    prompt: `You are a market monitoring agent for an autonomous trading system.

## Mission

Fetch and process market data, track positions, and flag noteworthy changes.

## Available Tools

### Trading Tools (Read-Only)
- \`mcp__trading__get_portfolio_summary\` - Get current portfolio overview
- \`mcp__trading__check_exit_triggers\` - Find positions hitting TP/SL

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
    tools: [
      'Read', 'Write', 'WebFetch', 'Bash', 'Grep',
      // Read-only trading tools
      'mcp__trading__get_portfolio_summary',
      'mcp__trading__check_exit_triggers',
    ],
    model: 'sonnet',
  },

  'hypothesis-tester': {
    description: 'Tests hypotheses by checking entry/exit conditions and executing trades',
    prompt: `You are a hypothesis testing agent.

## Mission

Check active hypotheses for entry/exit conditions and execute trades when criteria are met.

## Available Tools

### Trading Tools
- \`mcp__trading__execute_paper_trade\` - Execute a paper trade
- \`mcp__trading__exit_position\` - Close an open position
- \`mcp__trading__get_portfolio_summary\` - Get portfolio overview
- \`mcp__trading__check_exit_triggers\` - Find positions hitting TP/SL

### Hypothesis Tools
- \`mcp__hypothesis__transition_hypothesis\` - Change hypothesis status
- \`mcp__hypothesis__add_evidence\` - Record an observation
- \`mcp__hypothesis__get_hypothesis_summary\` - Get all hypotheses by status
- \`mcp__hypothesis__record_trade_result\` - Link trade outcome to hypothesis

## Process

1. Use get_hypothesis_summary to find hypotheses with status='testing'
2. For each hypothesis, check current market prices
3. If entry conditions met and not in position, use execute_paper_trade
4. If in position, use check_exit_triggers to find TP/SL hits
5. Use add_evidence to record all observations

## Key Rules

- Only trade hypotheses with confidence > 30%
- Follow position sizing rules
- Record all actions as evidence on the hypothesis`,
    tools: [
      'Read', 'Write', 'WebFetch', 'Bash', 'Grep',
      // Trading tools
      ...TRADING_TOOLS,
      // Hypothesis tools
      ...HYPOTHESIS_TOOLS,
    ],
    model: 'sonnet',
  },

  'researcher': {
    description: 'Deep research agent for investigating trading strategies, market mechanics, and academic literature',
    prompt: `You are a research agent specializing in prediction markets and trading strategies.

## Mission

Conduct deep research on topics related to prediction markets, trading strategies, and market mechanics.

## Available Tools

### Hypothesis Tools
- \`mcp__hypothesis__create_hypothesis\` - Create a new hypothesis
- \`mcp__hypothesis__add_evidence\` - Record an observation
- \`mcp__hypothesis__get_hypothesis_summary\` - Get all hypotheses by status
- \`mcp__hypothesis__get_related_learnings\` - Find related past learnings

## Capabilities

1. **Web research** - Search and analyze online sources
2. **Data analysis** - Process market data and identify patterns
3. **Literature review** - Find relevant academic papers and articles
4. **Synthesis** - Combine findings into actionable insights

## Output

- Use create_hypothesis for new hypothesis ideas
- Use add_evidence to update existing hypotheses
- Use get_related_learnings to avoid duplicating research`,
    tools: [
      'Read', 'Write', 'WebFetch', 'WebSearch', 'Bash', 'Grep',
      // Hypothesis tools
      ...HYPOTHESIS_TOOLS,
    ],
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

## Available Tools

### Trading Tools
- \`mcp__trading__execute_paper_trade\` - Execute a paper trade
- \`mcp__trading__exit_position\` - Close an open position
- \`mcp__trading__validate_trade\` - Check if a trade would be valid
- \`mcp__trading__get_approval_tier\` - Check approval requirements
- \`mcp__trading__get_portfolio_summary\` - Get portfolio overview
- \`mcp__trading__check_exit_triggers\` - Find positions hitting TP/SL

## Key Rules

- Use execute_paper_trade for all trades
- Follow approval tiers (tool handles this)
- Link trades to hypotheses (required parameter)`,
    tools: [
      'Read', 'Write', 'Bash',
      // Trading tools
      ...TRADING_TOOLS,
    ],
    model: 'sonnet',
  },
};

// Default options for all queries
const DEFAULT_OPTIONS: Partial<Options> = {
  permissionMode: 'bypassPermissions',
  allowDangerouslySkipPermissions: true,
  cwd: path.join(__dirname, '..'),
  settingSources: ['project'], // Load CLAUDE.md
  mcpServers: mcpServers, // Include custom trading tools
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
