/**
 * Handoff Tools
 *
 * Exposes handoff library functions as Claude Agent SDK tools.
 * Enables agent-to-agent communication.
 */

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  createHandoff,
  requestCapability,
  getPendingHandoffsFor,
  getHandoffsSummary,
  type Role,
  type HandoffType,
} from '../handoffs';

// Helper to format tool response
function toolResponse(data: unknown) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(data, null, 2),
    }],
  };
}

// Create the handoff tools MCP server
export const handoffToolsServer = createSdkMcpServer({
  name: 'handoffs',
  version: '1.0.0',
  tools: [
    // create_handoff - Create async request between agents
    tool(
      'create_handoff',
      'Create an async request from one agent to another. Used for inter-agent communication when not blocking.',
      {
        from: z.enum(['trade-research', 'agent-engineer']).describe('Source agent role'),
        to: z.enum(['trade-research', 'agent-engineer']).describe('Target agent role'),
        type: z.enum(['build_capability', 'fix_issue', 'analysis_request', 'trade_execution']).describe('Type of handoff'),
        context: z.record(z.unknown()).describe('Context object with relevant data'),
        priority: z.enum(['low', 'medium', 'high', 'critical']).optional().describe('Priority (default: medium)'),
      },
      async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
        try {
          const handoffId = createHandoff(
            args.from as Role,
            args.to as Role,
            args.type as HandoffType,
            args.context as Record<string, unknown>,
            args.priority || 'medium'
          );

          return toolResponse({
            success: true,
            handoffId,
            message: `Handoff ${handoffId} created: ${args.from} → ${args.to} (${args.type})`,
          });
        } catch (error: any) {
          return toolResponse({
            success: false,
            error: error.message || 'Failed to create handoff',
          });
        }
      }
    ),

    // request_capability - Ask Agent Engineer to build something
    tool(
      'request_capability',
      'Request Agent Engineer to build a capability you need. Shortcut for creating a build_capability handoff.',
      {
        description: z.string().describe('Description of the capability needed'),
        context: z.record(z.unknown()).optional().describe('Additional context'),
        priority: z.enum(['low', 'medium', 'high']).optional().describe('Priority (default: medium)'),
      },
      async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
        try {
          const handoffId = requestCapability(
            args.description,
            args.context || {},
            args.priority || 'medium'
          );

          return toolResponse({
            success: true,
            handoffId,
            message: `Capability request created: ${args.description.slice(0, 50)}...`,
          });
        } catch (error: any) {
          return toolResponse({
            success: false,
            error: error.message || 'Failed to request capability',
          });
        }
      }
    ),

    // get_pending_handoffs - Check handoff queue
    tool(
      'get_pending_handoffs',
      'Get pending handoffs for a specific role, sorted by priority.',
      {
        role: z.enum(['trade-research', 'agent-engineer']).describe('Agent role to check'),
      },
      async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
        try {
          const handoffs = getPendingHandoffsFor(args.role as Role);

          return toolResponse({
            success: true,
            handoffs: handoffs.map(h => ({
              id: h.id,
              from: h.from,
              type: h.type,
              priority: h.priority,
              context: h.context,
              createdAt: h.createdAt,
            })),
            count: handoffs.length,
            message: handoffs.length > 0
              ? `${handoffs.length} pending handoff(s) for ${args.role}`
              : `No pending handoffs for ${args.role}`,
          });
        } catch (error: any) {
          return toolResponse({
            success: false,
            error: error.message || 'Failed to get pending handoffs',
          });
        }
      }
    ),

    // get_handoffs_summary - Human-readable summary
    tool(
      'get_handoffs_summary',
      'Get a human-readable summary of all pending and in-progress handoffs.',
      {},
      async (): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
        try {
          const summary = getHandoffsSummary();
          return toolResponse({
            success: true,
            summary,
          });
        } catch (error: any) {
          return toolResponse({
            success: false,
            error: error.message || 'Failed to get handoffs summary',
          });
        }
      }
    ),
  ],
});

// Export tool names for agent configuration
export const HANDOFF_TOOLS = [
  'mcp__handoffs__create_handoff',
  'mcp__handoffs__request_capability',
  'mcp__handoffs__get_pending_handoffs',
  'mcp__handoffs__get_handoffs_summary',
];
