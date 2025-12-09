/**
 * Trading Tools
 *
 * Exposes trading library functions as Claude Agent SDK tools.
 * Uses createSdkMcpServer for in-process tool execution.
 */

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  executePaperTrade,
  exitPosition,
  validateTrade,
  getApprovalTier,
  getPortfolioSummary,
  checkExitTriggers,
  loadPortfolio,
  type TradeParams,
  type TradeResult,
  type ValidationResult,
  type ApprovalTier,
} from '../trading';

// Zod schemas for tool parameters
const ExitCriteriaSchema = z.object({
  takeProfit: z.number().min(0).max(1).describe('Price to exit with profit (0-1, e.g., 0.20 = 20 cents)'),
  stopLoss: z.number().min(0).max(1).describe('Price to exit with loss (0-1, e.g., 0.04 = 4 cents)'),
  timeLimit: z.string().optional().describe('ISO date string - exit by this time'),
  notes: z.string().optional().describe('Additional exit notes'),
});

const TradeParamsSchema = z.object({
  market: z.string().describe('Market slug (e.g., "will-bitcoin-reach-100k-2024")'),
  marketQuestion: z.string().optional().describe('Human-readable market question'),
  direction: z.enum(['YES', 'NO']).describe('Position direction'),
  outcome: z.string().optional().describe('For multi-outcome markets (e.g., "Apple")'),
  amount: z.number().positive().describe('USD amount to spend'),
  price: z.number().min(0).max(1).describe('Expected entry price (0-1)'),
  hypothesisId: z.string().describe('Linked hypothesis ID (required)'),
  rationale: z.string().describe('Why you are making this trade'),
  exitCriteria: ExitCriteriaSchema,
  tokenId: z.string().optional().describe('Token ID for API execution'),
});

// Helper to format tool response
function toolResponse(data: unknown) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(data, null, 2),
    }],
  };
}

// Create the trading tools MCP server
export const tradingToolsServer = createSdkMcpServer({
  name: 'trading',
  version: '1.0.0',
  tools: [
    // execute_paper_trade - Enter a position
    tool(
      'execute_paper_trade',
      'Execute a paper trade (simulated). Handles validation, approval tiers, and state updates automatically.',
      TradeParamsSchema.shape,
      async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
        try {
          const params: TradeParams = {
            market: args.market,
            marketQuestion: args.marketQuestion,
            direction: args.direction,
            outcome: args.outcome,
            amount: args.amount,
            price: args.price,
            hypothesisId: args.hypothesisId,
            rationale: args.rationale,
            exitCriteria: args.exitCriteria,
            tokenId: args.tokenId,
          };

          const result = await executePaperTrade(params);

          if (result.success) {
            return toolResponse({
              success: true,
              tradeId: result.tradeId,
              shares: result.shares,
              cost: result.cost,
              message: `Trade executed: ${result.shares} shares at ${(args.price * 100).toFixed(1)} cents`,
            });
          } else if (result.requiresApproval) {
            return toolResponse({
              success: false,
              requiresApproval: true,
              approvalId: result.approvalId,
              message: `Trade requires CEO approval. Approval ID: ${result.approvalId}`,
            });
          } else {
            return toolResponse({
              success: false,
              error: result.error,
            });
          }
        } catch (error: any) {
          return toolResponse({
            success: false,
            error: error.message || 'Unknown error executing trade',
          });
        }
      }
    ),

    // exit_position - Close a position
    tool(
      'exit_position',
      'Close an open position. Calculates P&L and updates hypothesis with trade result.',
      {
        positionId: z.string().describe('Position ID to close'),
        exitPrice: z.number().min(0).max(1).describe('Exit price (0-1)'),
        reason: z.string().describe('Reason for exiting (e.g., "stop_loss", "take_profit", "manual")'),
      },
      async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
        try {
          const result = await exitPosition(args.positionId, args.exitPrice, args.reason);

          if (result.success) {
            return toolResponse({
              success: true,
              tradeId: result.tradeId,
              message: `Position ${args.positionId} closed at ${(args.exitPrice * 100).toFixed(1)} cents`,
            });
          } else {
            return toolResponse({
              success: false,
              error: result.error,
            });
          }
        } catch (error: any) {
          return toolResponse({
            success: false,
            error: error.message || 'Unknown error exiting position',
          });
        }
      }
    ),

    // validate_trade - Check if trade is valid without executing
    tool(
      'validate_trade',
      'Check if a trade would be valid without executing it. Returns validation result with any errors or warnings.',
      {
        market: z.string().describe('Market slug'),
        direction: z.enum(['YES', 'NO']).describe('Position direction'),
        amount: z.number().positive().describe('USD amount'),
        price: z.number().min(0).max(1).describe('Entry price (0-1)'),
        hypothesisId: z.string().describe('Linked hypothesis ID'),
      },
      async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
        try {
          const portfolio = loadPortfolio();
          const params: TradeParams = {
            market: args.market,
            direction: args.direction,
            amount: args.amount,
            price: args.price,
            hypothesisId: args.hypothesisId,
            rationale: '', // Not needed for validation
            exitCriteria: { takeProfit: 0.9, stopLoss: 0.1 }, // Placeholder
          };

          const result = validateTrade(params, portfolio);

          return toolResponse({
            valid: result.valid,
            error: result.error,
            warnings: result.warnings,
          });
        } catch (error: any) {
          return toolResponse({
            valid: false,
            error: error.message || 'Unknown error validating trade',
          });
        }
      }
    ),

    // get_approval_tier - Check what approval is needed
    tool(
      'get_approval_tier',
      'Check what approval tier applies for a trade amount. Returns "auto" (execute), "notify" (execute and notify), or "approve" (requires CEO approval).',
      {
        amount: z.number().positive().describe('Trade amount in USD'),
      },
      async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
        const params: TradeParams = {
          market: '',
          direction: 'YES',
          amount: args.amount,
          price: 0.5,
          hypothesisId: '',
          rationale: '',
          exitCriteria: { takeProfit: 0.9, stopLoss: 0.1 },
        };

        const tier = getApprovalTier(params);

        return toolResponse({
          tier,
          amount: args.amount,
          description: tier === 'auto'
            ? 'Trade will execute automatically'
            : tier === 'notify'
            ? 'Trade will execute and notify CEO'
            : 'Trade requires CEO approval before execution',
        });
      }
    ),

    // get_portfolio_summary - Get portfolio overview
    tool(
      'get_portfolio_summary',
      'Get a formatted summary of the current portfolio including cash, positions, P&L, and constraints.',
      {},
      async (): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
        try {
          const summary = getPortfolioSummary();
          return toolResponse({
            success: true,
            summary,
          });
        } catch (error: any) {
          return toolResponse({
            success: false,
            error: error.message || 'Failed to get portfolio summary',
          });
        }
      }
    ),

    // check_exit_triggers - Find positions hitting TP/SL
    tool(
      'check_exit_triggers',
      'Check all positions for exit triggers (stop loss, take profit, time limit). Returns positions that should be closed.',
      {},
      async (): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
        try {
          const portfolio = loadPortfolio();
          const triggers = checkExitTriggers(portfolio);

          if (triggers.length === 0) {
            return toolResponse({
              success: true,
              triggers: [],
              message: 'No exit triggers hit',
            });
          }

          return toolResponse({
            success: true,
            triggers: triggers.map(t => ({
              positionId: t.position.id,
              market: t.position.market,
              trigger: t.trigger,
              currentPrice: t.currentPrice,
              entryPrice: t.position.entryPrice,
              exitCriteria: t.position.exitCriteria,
            })),
            message: `${triggers.length} position(s) have exit triggers`,
          });
        } catch (error: any) {
          return toolResponse({
            success: false,
            error: error.message || 'Failed to check exit triggers',
          });
        }
      }
    ),
  ],
});

// Export tool names for agent configuration
export const TRADING_TOOLS = [
  'mcp__trading__execute_paper_trade',
  'mcp__trading__exit_position',
  'mcp__trading__validate_trade',
  'mcp__trading__get_approval_tier',
  'mcp__trading__get_portfolio_summary',
  'mcp__trading__check_exit_triggers',
];
