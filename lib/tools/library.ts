/**
 * Library Tools
 *
 * Exposes knowledge library functions as Claude Agent SDK tools.
 * Uses createSdkMcpServer for in-process tool execution.
 */

import { tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  librarySearch,
  libraryAdd,
  libraryGet,
  libraryGetAll,
  libraryFindContradictions,
  libraryUpdate,
  libraryList,
  type Learning,
  type LearningCategory,
  type LearningSourceType,
} from '../library';

// Helper to format tool response
function toolResponse(data: unknown) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify(data, null, 2),
    }],
  };
}

// Create the library tools MCP server
export const libraryToolsServer = createSdkMcpServer({
  name: 'library',
  version: '1.0.0',
  tools: [
    // search - Search learnings by query and filters
    tool(
      'search',
      'Search learnings by query and/or tags. Returns matching learnings with full content.',
      {
        query: z.string().describe('Search terms to match against claims and content'),
        tags: z.array(z.string()).optional().describe('Filter by tags (all must match)'),
        category: z.enum(['strategy', 'market', 'meta', 'tooling', 'hypothesis']).optional().describe('Filter by category'),
      },
      async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
        try {
          const results = librarySearch(args.query, {
            tags: args.tags,
            category: args.category as LearningCategory | undefined,
          });

          return toolResponse({
            success: true,
            count: results.length,
            learnings: results.map(l => ({
              id: l.id,
              claim: l.claim,
              confidence: l.confidence,
              tags: l.tags,
              category: l.category,
              source: l.source,
              content: l.content.slice(0, 500) + (l.content.length > 500 ? '...' : ''),
            })),
          });
        } catch (error: any) {
          return toolResponse({
            success: false,
            error: error.message || 'Failed to search library',
          });
        }
      }
    ),

    // get_all_claims - Get all claims for quick context
    tool(
      'get_all_claims',
      'Get all learning claims for quick context scanning. Returns compact id + claim pairs.',
      {},
      async (): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
        try {
          const claims = libraryGetAll();
          return toolResponse({
            success: true,
            count: claims.length,
            claims,
          });
        } catch (error: any) {
          return toolResponse({
            success: false,
            error: error.message || 'Failed to get claims',
          });
        }
      }
    ),

    // add - Add a new learning
    tool(
      'add',
      'Add a new learning to the library. Use this to store insights, findings, and validated knowledge.',
      {
        claim: z.string().describe('Dense single-sentence insight - the core claim'),
        content: z.string().describe('Full markdown explanation with context and evidence'),
        tags: z.array(z.string()).describe('Tags for retrieval (e.g., ["momentum", "sports", "closing"])'),
        category: z.enum(['strategy', 'market', 'meta', 'tooling', 'hypothesis']).describe('Category of learning'),
        confidence: z.number().min(0).max(1).describe('Confidence in this claim (0-1)'),
        source: z.string().describe('Where this came from (descriptive)'),
        sourceType: z.enum(['experiment', 'paper', 'trader-analysis', 'observation', 'ceo-shared']).describe('Type of source'),
        appliedTo: z.array(z.string()).optional().describe('Related hypothesis/strategy IDs'),
      },
      async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
        try {
          const learning = libraryAdd({
            claim: args.claim,
            content: args.content,
            tags: args.tags,
            category: args.category as LearningCategory,
            confidence: args.confidence,
            source: args.source,
            sourceType: args.sourceType as LearningSourceType,
            appliedTo: args.appliedTo || [],
          });

          return toolResponse({
            success: true,
            id: learning.id,
            message: `Learning added: ${learning.id}`,
            learning: {
              id: learning.id,
              claim: learning.claim,
              confidence: learning.confidence,
            },
          });
        } catch (error: any) {
          return toolResponse({
            success: false,
            error: error.message || 'Failed to add learning',
          });
        }
      }
    ),

    // find_contradictions - Check for conflicting learnings
    tool(
      'find_contradictions',
      'Find learnings that might contradict a claim. Use this to check if new information conflicts with existing knowledge.',
      {
        claim: z.string().describe('The claim to check for contradictions'),
      },
      async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
        try {
          const contradictions = libraryFindContradictions(args.claim);

          return toolResponse({
            success: true,
            count: contradictions.length,
            hasContradictions: contradictions.length > 0,
            contradictions: contradictions.map(l => ({
              id: l.id,
              claim: l.claim,
              confidence: l.confidence,
              content: l.content.slice(0, 300) + (l.content.length > 300 ? '...' : ''),
            })),
          });
        } catch (error: any) {
          return toolResponse({
            success: false,
            error: error.message || 'Failed to find contradictions',
          });
        }
      }
    ),

    // get - Get a specific learning by ID
    tool(
      'get',
      'Get a specific learning by ID. Returns full learning details.',
      {
        id: z.string().describe('Learning ID (e.g., "learning-abc123")'),
      },
      async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
        try {
          const learning = libraryGet(args.id);

          if (!learning) {
            return toolResponse({
              success: false,
              error: `Learning ${args.id} not found`,
            });
          }

          return toolResponse({
            success: true,
            learning,
          });
        } catch (error: any) {
          return toolResponse({
            success: false,
            error: error.message || 'Failed to get learning',
          });
        }
      }
    ),

    // update - Update an existing learning
    tool(
      'update',
      'Update an existing learning. Use this to adjust confidence, add references, or refine content.',
      {
        id: z.string().describe('Learning ID to update'),
        confidence: z.number().min(0).max(1).optional().describe('New confidence level'),
        content: z.string().optional().describe('Updated content'),
        tags: z.array(z.string()).optional().describe('Updated tags'),
        appliedTo: z.array(z.string()).optional().describe('Updated related IDs'),
      },
      async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
        try {
          const updates: Partial<Learning> = {};
          if (args.confidence !== undefined) updates.confidence = args.confidence;
          if (args.content !== undefined) updates.content = args.content;
          if (args.tags !== undefined) updates.tags = args.tags;
          if (args.appliedTo !== undefined) updates.appliedTo = args.appliedTo;

          const learning = libraryUpdate(args.id, updates);

          if (!learning) {
            return toolResponse({
              success: false,
              error: `Learning ${args.id} not found`,
            });
          }

          return toolResponse({
            success: true,
            message: `Learning ${args.id} updated`,
            learning: {
              id: learning.id,
              claim: learning.claim,
              confidence: learning.confidence,
              updatedAt: learning.updatedAt,
            },
          });
        } catch (error: any) {
          return toolResponse({
            success: false,
            error: error.message || 'Failed to update learning',
          });
        }
      }
    ),

    // list - List learnings with filters
    tool(
      'list',
      'List learnings with optional filtering. Returns compact list items.',
      {
        category: z.enum(['strategy', 'market', 'meta', 'tooling', 'hypothesis']).optional().describe('Filter by category'),
        tag: z.string().optional().describe('Filter by tag'),
        limit: z.number().optional().describe('Max results to return'),
      },
      async (args): Promise<{ content: Array<{ type: 'text'; text: string }> }> => {
        try {
          const results = libraryList({
            category: args.category as LearningCategory | undefined,
            tag: args.tag,
            limit: args.limit,
          });

          return toolResponse({
            success: true,
            count: results.length,
            learnings: results,
          });
        } catch (error: any) {
          return toolResponse({
            success: false,
            error: error.message || 'Failed to list learnings',
          });
        }
      }
    ),
  ],
});

// Export tool names for agent configuration
export const LIBRARY_TOOLS = [
  'mcp__library__search',
  'mcp__library__get_all_claims',
  'mcp__library__add',
  'mcp__library__find_contradictions',
  'mcp__library__get',
  'mcp__library__update',
  'mcp__library__list',
];
