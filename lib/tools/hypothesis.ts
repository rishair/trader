/**
 * Hypothesis Tools
 *
 * Exposes hypothesis library functions as Claude Agent SDK tools.
 * Includes state machine transitions, evidence tracking, and learning integration.
 */

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  createHypothesis,
  transitionHypothesis,
  addEvidence,
  blockHypothesis,
  recordTradeResult,
  linkMarketToHypothesis,
  selectNextHypothesis,
  getHypothesisSummary,
  getRelatedLearnings,
  hasTradeValidation,
  loadHypothesis,
  type HypothesisStatus,
  type LinkedMarket,
} from '../hypothesis';

// Helper to format tool response
function toolResponse(data: unknown) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(data, null, 2),
    }],
  };
}

// Create the hypothesis tools MCP server
export const hypothesisToolsServer = createSdkMcpServer({
  name: 'hypothesis',
  version: '1.0.0',
  tools: [
    // create_hypothesis - Create new hypothesis
    tool(
      'create_hypothesis',
      'Create a new hypothesis for testing. Returns the created hypothesis with its ID.',
      {
        statement: z.string().describe('The hypothesis statement (what you believe to be true)'),
        rationale: z.string().describe('Why you believe this hypothesis'),
        testMethod: z.string().describe('How to test this hypothesis'),
        source: z.string().optional().describe('Source of the hypothesis (e.g., "ceo-shared", "research", "observation")'),
        entryRules: z.string().optional().describe('Specific rules for entering trades'),
        exitRules: z.string().optional().describe('Specific rules for exiting trades'),
        expectedWinRate: z.number().min(0).max(1).optional().describe('Expected win rate (0-1)'),
        expectedPayoff: z.number().optional().describe('Expected payoff ratio'),
        minSampleSize: z.number().int().positive().optional().describe('Minimum trades needed to validate'),
        initialConfidence: z.number().min(0).max(1).optional().describe('Initial confidence (0-1, default 0.5)'),
      },
      async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
        try {
          const hypothesis = createHypothesis({
            statement: args.statement,
            rationale: args.rationale,
            testMethod: args.testMethod,
            source: args.source,
            entryRules: args.entryRules,
            exitRules: args.exitRules,
            expectedWinRate: args.expectedWinRate,
            expectedPayoff: args.expectedPayoff,
            minSampleSize: args.minSampleSize,
            initialConfidence: args.initialConfidence,
          });

          return toolResponse({
            success: true,
            hypothesis: {
              id: hypothesis.id,
              statement: hypothesis.statement,
              status: hypothesis.status,
              confidence: hypothesis.confidence,
            },
            message: `Created hypothesis ${hypothesis.id}. Use /test ${hypothesis.id} to start testing immediately.`,
          });
        } catch (error: any) {
          return toolResponse({
            success: false,
            error: error.message || 'Failed to create hypothesis',
          });
        }
      }
    ),

    // transition_hypothesis - Change hypothesis status
    tool(
      'transition_hypothesis',
      'Transition a hypothesis to a new status. Valid transitions: proposed→testing, testing→validated/invalidated, any→blocked, blocked→proposed/testing.',
      {
        hypothesisId: z.string().describe('Hypothesis ID'),
        targetStatus: z.enum(['proposed', 'testing', 'validated', 'invalidated', 'blocked']).describe('Target status'),
        reason: z.string().describe('Reason for the transition'),
      },
      async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
        try {
          const result = await transitionHypothesis(
            args.hypothesisId,
            args.targetStatus as HypothesisStatus,
            args.reason
          );

          if (result.success) {
            return toolResponse({
              success: true,
              hypothesis: {
                id: result.hypothesis!.id,
                status: result.hypothesis!.status,
                confidence: result.hypothesis!.confidence,
              },
              message: `Hypothesis ${args.hypothesisId} transitioned to ${args.targetStatus}`,
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
            error: error.message || 'Failed to transition hypothesis',
          });
        }
      }
    ),

    // add_evidence - Record observation
    tool(
      'add_evidence',
      'Add evidence to a hypothesis. Automatically updates confidence and may trigger auto-transitions.',
      {
        hypothesisId: z.string().describe('Hypothesis ID'),
        observation: z.string().describe('What was observed'),
        supports: z.boolean().nullable().describe('Does this support the hypothesis? (true/false/null for neutral)'),
        confidenceImpact: z.number().min(-0.5).max(0.5).describe('Impact on confidence (-0.5 to +0.5)'),
      },
      async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
        try {
          const result = await addEvidence(
            args.hypothesisId,
            args.observation,
            args.supports,
            args.confidenceImpact
          );

          if (result.success) {
            return toolResponse({
              success: true,
              hypothesis: {
                id: result.hypothesis!.id,
                status: result.hypothesis!.status,
                confidence: result.hypothesis!.confidence,
                evidenceCount: result.hypothesis!.evidence.length,
              },
              message: `Evidence added. Confidence now ${(result.hypothesis!.confidence * 100).toFixed(0)}%`,
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
            error: error.message || 'Failed to add evidence',
          });
        }
      }
    ),

    // block_hypothesis - Block on capability
    tool(
      'block_hypothesis',
      'Block a hypothesis pending a capability. Creates a handoff to Agent Engineer.',
      {
        hypothesisId: z.string().describe('Hypothesis ID'),
        capabilityNeeded: z.string().describe('What capability is needed'),
        priority: z.enum(['low', 'medium', 'high']).optional().describe('Priority for the capability request'),
      },
      async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
        try {
          const result = await blockHypothesis(
            args.hypothesisId,
            args.capabilityNeeded,
            args.priority || 'medium'
          );

          if (result.success) {
            return toolResponse({
              success: true,
              hypothesis: {
                id: result.hypothesis!.id,
                status: result.hypothesis!.status,
                blockedReason: result.hypothesis!.blockedReason,
                blockedHandoffId: result.hypothesis!.blockedHandoffId,
              },
              message: `Hypothesis blocked. Handoff created for Agent Engineer.`,
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
            error: error.message || 'Failed to block hypothesis',
          });
        }
      }
    ),

    // select_next_hypothesis - Pick next to work on
    tool(
      'select_next_hypothesis',
      'Select the next hypothesis to focus on based on priority scoring (confidence, learnings support, time sensitivity, etc.).',
      {},
      async (): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
        try {
          const selection = selectNextHypothesis();

          if (!selection.hypothesis) {
            return toolResponse({
              success: true,
              hypothesis: null,
              message: 'No testable hypotheses available. Create new hypotheses first.',
            });
          }

          return toolResponse({
            success: true,
            hypothesis: {
              id: selection.hypothesis.id,
              statement: selection.hypothesis.statement,
              status: selection.hypothesis.status,
              confidence: selection.hypothesis.confidence,
              linkedMarket: selection.hypothesis.linkedMarket,
            },
            score: selection.score,
            alternatives: selection.alternatives,
            message: `Recommended: ${selection.hypothesis.id} (score: ${selection.score!.score.toFixed(2)})`,
          });
        } catch (error: any) {
          return toolResponse({
            success: false,
            error: error.message || 'Failed to select hypothesis',
          });
        }
      }
    ),

    // get_hypothesis_summary - Get all hypotheses
    tool(
      'get_hypothesis_summary',
      'Get a formatted summary of all hypotheses grouped by status.',
      {},
      async (): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
        try {
          const summary = getHypothesisSummary();
          return toolResponse({
            success: true,
            summary,
          });
        } catch (error: any) {
          return toolResponse({
            success: false,
            error: error.message || 'Failed to get hypothesis summary',
          });
        }
      }
    ),

    // record_trade_result - Link trade outcome to hypothesis
    tool(
      'record_trade_result',
      'Record a trade result for a hypothesis. Updates win/loss count and P&L tracking.',
      {
        hypothesisId: z.string().describe('Hypothesis ID'),
        won: z.boolean().describe('Did the trade win?'),
        pnl: z.number().describe('Profit/loss amount in USD'),
      },
      async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
        try {
          const result = recordTradeResult(args.hypothesisId, args.won, args.pnl);

          if (result.success) {
            return toolResponse({
              success: true,
              testResults: result.hypothesis!.testResults,
              message: `Recorded ${args.won ? 'winning' : 'losing'} trade ($${args.pnl.toFixed(2)})`,
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
            error: error.message || 'Failed to record trade result',
          });
        }
      }
    ),

    // get_related_learnings - Find past learnings
    tool(
      'get_related_learnings',
      'Find learnings from the library that are related to a hypothesis.',
      {
        hypothesisId: z.string().describe('Hypothesis ID'),
      },
      async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
        try {
          const hypothesis = loadHypothesis(args.hypothesisId);
          if (!hypothesis) {
            return toolResponse({
              success: false,
              error: `Hypothesis ${args.hypothesisId} not found`,
            });
          }

          const learnings = getRelatedLearnings(hypothesis);

          return toolResponse({
            success: true,
            learnings: learnings.map(l => ({
              id: l.id,
              claim: l.claim,
              confidence: l.confidence,
              tags: l.tags,
            })),
            count: learnings.length,
            message: learnings.length > 0
              ? `Found ${learnings.length} related learnings`
              : 'No related learnings found',
          });
        } catch (error: any) {
          return toolResponse({
            success: false,
            error: error.message || 'Failed to find related learnings',
          });
        }
      }
    ),

    // has_trade_validation - Check if hypothesis is validated for >$50
    tool(
      'has_trade_validation',
      'Check if a hypothesis has sufficient validation for larger trades (>$50). Requires backtest results or sufficient evidence.',
      {
        hypothesisId: z.string().describe('Hypothesis ID'),
      },
      async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
        try {
          const validation = hasTradeValidation(args.hypothesisId);

          return toolResponse({
            success: true,
            validated: validation.validated,
            reason: validation.reason,
            backtestData: validation.backtestData,
          });
        } catch (error: any) {
          return toolResponse({
            success: false,
            error: error.message || 'Failed to check trade validation',
          });
        }
      }
    ),

    // link_market_to_hypothesis - Associate market with hypothesis
    tool(
      'link_market_to_hypothesis',
      'Link a Polymarket market to a hypothesis for testing. Required before the hypothesis-tester can execute trades.',
      {
        hypothesisId: z.string().describe('Hypothesis ID'),
        slug: z.string().describe('Market slug'),
        question: z.string().describe('Market question'),
        tokenId: z.string().describe('Token ID for the market'),
      },
      async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
        try {
          const market: LinkedMarket = {
            slug: args.slug,
            question: args.question,
            tokenId: args.tokenId,
          };

          const result = linkMarketToHypothesis(args.hypothesisId, market);

          if (result.success) {
            return toolResponse({
              success: true,
              hypothesis: {
                id: result.hypothesis!.id,
                linkedMarket: result.hypothesis!.linkedMarket,
              },
              message: `Linked ${args.slug} to hypothesis ${args.hypothesisId}`,
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
            error: error.message || 'Failed to link market to hypothesis',
          });
        }
      }
    ),
  ],
});

// Export tool names for agent configuration
export const HYPOTHESIS_TOOLS = [
  'mcp__hypothesis__create_hypothesis',
  'mcp__hypothesis__transition_hypothesis',
  'mcp__hypothesis__add_evidence',
  'mcp__hypothesis__block_hypothesis',
  'mcp__hypothesis__select_next_hypothesis',
  'mcp__hypothesis__get_hypothesis_summary',
  'mcp__hypothesis__record_trade_result',
  'mcp__hypothesis__get_related_learnings',
  'mcp__hypothesis__has_trade_validation',
  'mcp__hypothesis__link_market_to_hypothesis',
];
