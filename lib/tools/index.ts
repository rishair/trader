/**
 * Tools Index
 *
 * Exports all tool servers and tool name constants for agent configuration.
 */

// Tool servers
export { tradingToolsServer, TRADING_TOOLS } from './trading';
export { hypothesisToolsServer, HYPOTHESIS_TOOLS } from './hypothesis';
export { handoffToolsServer, HANDOFF_TOOLS } from './handoffs';
export { libraryToolsServer, LIBRARY_TOOLS } from './library';

// Aggregated tool lists by role
export const ALL_TRADING_TOOLS = [
  ...require('./trading').TRADING_TOOLS,
  ...require('./hypothesis').HYPOTHESIS_TOOLS,
  ...require('./handoffs').HANDOFF_TOOLS,
  ...require('./library').LIBRARY_TOOLS,
];

// Tool sets for specific agents
export const TRADE_RESEARCH_TOOLS = [
  ...require('./trading').TRADING_TOOLS,
  ...require('./hypothesis').HYPOTHESIS_TOOLS,
  ...require('./handoffs').HANDOFF_TOOLS,
  ...require('./library').LIBRARY_TOOLS,
];

export const TRADE_EXECUTOR_TOOLS = [
  ...require('./trading').TRADING_TOOLS,
];

export const HYPOTHESIS_TESTER_TOOLS = [
  ...require('./trading').TRADING_TOOLS,
  ...require('./hypothesis').HYPOTHESIS_TOOLS,
];

export const MARKET_WATCHER_TOOLS = [
  'mcp__trading__get_portfolio_summary',
  'mcp__trading__check_exit_triggers',
];

export const AGENT_ENGINEER_TOOLS = [
  ...require('./handoffs').HANDOFF_TOOLS,
];

export const RESEARCHER_TOOLS = [
  ...require('./hypothesis').HYPOTHESIS_TOOLS,
  ...require('./library').LIBRARY_TOOLS,
];
