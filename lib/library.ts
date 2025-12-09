/**
 * Knowledge Library
 *
 * Structured storage and retrieval of learnings.
 * Each learning has a dense single-sentence claim for quick recall,
 * plus full content for deep reference.
 *
 * Usage:
 *   import { libraryList, librarySearch, libraryAdd, libraryGetAll } from './lib/library';
 *
 *   // Get all claims for context
 *   const claims = libraryGetAll();
 *
 *   // Search for relevant knowledge
 *   const relevant = librarySearch('momentum', { tags: ['closing'] });
 *
 *   // Add new insight
 *   libraryAdd({ claim: '...', content: '...', tags: [...], ... });
 */

import * as fs from 'fs';
import * as path from 'path';

const STATE_DIR = path.join(__dirname, '..', 'state');
const LEARNINGS_FILE = path.join(STATE_DIR, 'trading/learnings.json');

// ============================================================================
// Types
// ============================================================================

export type LearningCategory = 'strategy' | 'market' | 'meta' | 'tooling' | 'hypothesis';
export type LearningSourceType = 'experiment' | 'paper' | 'trader-analysis' | 'observation' | 'ceo-shared';

export interface Learning {
  id: string;
  claim: string;              // Dense single sentence - the core insight
  content: string;            // Full markdown explanation
  tags: string[];             // For retrieval: ["momentum", "closing", "sports"]
  category: LearningCategory; // strategy | market | meta | tooling | hypothesis
  confidence: number;         // 0-1, how confident we are in this claim
  source: string;             // Where this came from (descriptive)
  sourceType: LearningSourceType; // experiment | paper | trader-analysis | observation | ceo-shared
  appliedTo: string[];        // Hypothesis/strategy IDs this relates to
  contradicts?: string[];     // Learning IDs this conflicts with
  updatesStrategy?: string[]; // Strategy IDs to auto-update when this changes
  createdAt: string;
  updatedAt: string;
  references?: string[];
  // Legacy fields (for backwards compatibility)
  title?: string;
  actionable?: boolean;
}

export interface LearningListItem {
  id: string;
  claim: string;
  tags: string[];
  confidence: number;
}

export interface LearningClaimItem {
  id: string;
  claim: string;
}

// ============================================================================
// State I/O
// ============================================================================

interface LearningsState {
  insights: Learning[];
}

function loadLearnings(): Learning[] {
  try {
    const data = JSON.parse(fs.readFileSync(LEARNINGS_FILE, 'utf-8')) as LearningsState;
    return data.insights || [];
  } catch {
    return [];
  }
}

function saveLearnings(learnings: Learning[]): void {
  const data: LearningsState = { insights: learnings };
  fs.writeFileSync(LEARNINGS_FILE, JSON.stringify(data, null, 2));
}

// ============================================================================
// Core Library Functions
// ============================================================================

/**
 * List learnings with optional filtering.
 * Returns compact list items (id, claim, tags, confidence).
 */
export function libraryList(options?: {
  category?: LearningCategory;
  tag?: string;
  limit?: number;
}): LearningListItem[] {
  let learnings = loadLearnings();

  // Filter by category
  if (options?.category) {
    learnings = learnings.filter(l => l.category === options.category);
  }

  // Filter by tag
  if (options?.tag) {
    const tag = options.tag.toLowerCase();
    learnings = learnings.filter(l =>
      l.tags?.some(t => t.toLowerCase() === tag)
    );
  }

  // Limit results
  if (options?.limit && options.limit > 0) {
    learnings = learnings.slice(0, options.limit);
  }

  return learnings.map(l => ({
    id: l.id,
    claim: l.claim || l.title || '', // Fallback to title if claim not migrated
    tags: l.tags || [],
    confidence: l.confidence ?? 0.7,
  }));
}

/**
 * Search learnings by query string and optional filters.
 * Matches against claim, content, and tags.
 */
export function librarySearch(query: string, options?: {
  tags?: string[];
  category?: LearningCategory;
}): Learning[] {
  let learnings = loadLearnings();

  // Filter by category
  if (options?.category) {
    learnings = learnings.filter(l => l.category === options.category);
  }

  // Filter by tags (all must match)
  if (options?.tags && options.tags.length > 0) {
    const requiredTags = options.tags.map(t => t.toLowerCase());
    learnings = learnings.filter(l =>
      requiredTags.every(rt =>
        l.tags?.some(t => t.toLowerCase() === rt)
      )
    );
  }

  // Search by query
  if (query && query.trim()) {
    const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    learnings = learnings.filter(l => {
      const searchText = `${l.claim || ''} ${l.title || ''} ${l.content} ${l.tags?.join(' ') || ''}`.toLowerCase();
      return terms.some(term => searchText.includes(term));
    });

    // Sort by relevance (more term matches = higher rank)
    learnings.sort((a, b) => {
      const aText = `${a.claim || ''} ${a.title || ''} ${a.content}`.toLowerCase();
      const bText = `${b.claim || ''} ${b.title || ''} ${b.content}`.toLowerCase();
      const aScore = terms.filter(t => aText.includes(t)).length;
      const bScore = terms.filter(t => bText.includes(t)).length;
      return bScore - aScore;
    });
  }

  return learnings;
}

/**
 * Add a new learning to the library.
 * Generates ID and timestamps automatically.
 */
export function libraryAdd(learning: Omit<Learning, 'id' | 'createdAt' | 'updatedAt'>): Learning {
  const learnings = loadLearnings();

  const now = new Date().toISOString();
  const id = `learning-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  const newLearning: Learning = {
    ...learning,
    id,
    createdAt: now,
    updatedAt: now,
  };

  learnings.push(newLearning);
  saveLearnings(learnings);

  console.log(`[Library] Added learning ${id}: ${learning.claim.slice(0, 50)}...`);

  return newLearning;
}

/**
 * Get a specific learning by ID.
 */
export function libraryGet(id: string): Learning | null {
  const learnings = loadLearnings();
  return learnings.find(l => l.id === id) || null;
}

/**
 * Update a learning.
 * Handles strategy sync if updatesStrategy is defined.
 */
export function libraryUpdate(id: string, updates: Partial<Learning>): Learning | null {
  const learnings = loadLearnings();
  const index = learnings.findIndex(l => l.id === id);

  if (index === -1) {
    console.error(`[Library] Learning ${id} not found`);
    return null;
  }

  const updated: Learning = {
    ...learnings[index],
    ...updates,
    id, // Preserve ID
    createdAt: learnings[index].createdAt, // Preserve creation time
    updatedAt: new Date().toISOString(),
  };

  learnings[index] = updated;
  saveLearnings(learnings);

  console.log(`[Library] Updated learning ${id}`);

  // If this learning should update strategies, trigger sync
  if (updated.updatesStrategy && updated.updatesStrategy.length > 0) {
    syncStrategiesFromLearning(updated);
  }

  return updated;
}

/**
 * Get all learnings as id + claim pairs.
 * Designed for giving agents full context in a compact format.
 */
export function libraryGetAll(): LearningClaimItem[] {
  const learnings = loadLearnings();
  return learnings.map(l => ({
    id: l.id,
    claim: l.claim || l.title || '', // Fallback to title if claim not migrated
  }));
}

/**
 * Find learnings that might contradict a claim.
 * Uses simple keyword overlap and looks for opposing sentiment.
 */
export function libraryFindContradictions(claim: string): Learning[] {
  const learnings = loadLearnings();
  const claimLower = claim.toLowerCase();

  // Keywords that suggest contradiction
  const contradictionSignals = [
    ['momentum', 'mean-reversion'],
    ['overpriced', 'underpriced'],
    ['profitable', 'unprofitable'],
    ['works', 'doesn\'t work'],
    ['effective', 'ineffective'],
    ['high', 'low'],
    ['increase', 'decrease'],
  ];

  const potentialContradictions: Learning[] = [];

  for (const learning of learnings) {
    const learningText = `${learning.claim || ''} ${learning.content}`.toLowerCase();

    // Check if they share context (similar topic)
    const claimWords = claimLower.split(/\s+/).filter(w => w.length > 3);
    const sharedWords = claimWords.filter(w => learningText.includes(w));

    // Need some overlap to be relevant
    if (sharedWords.length < 2) continue;

    // Check for contradiction signals
    for (const [word1, word2] of contradictionSignals) {
      const claimHas1 = claimLower.includes(word1);
      const claimHas2 = claimLower.includes(word2);
      const learningHas1 = learningText.includes(word1);
      const learningHas2 = learningText.includes(word2);

      if ((claimHas1 && learningHas2) || (claimHas2 && learningHas1)) {
        potentialContradictions.push(learning);
        break;
      }
    }
  }

  return potentialContradictions;
}

/**
 * Mark a learning as contradicting another.
 * Updates both learnings' contradicts arrays.
 */
export function libraryMarkContradiction(id1: string, id2: string): void {
  const learnings = loadLearnings();
  const l1 = learnings.find(l => l.id === id1);
  const l2 = learnings.find(l => l.id === id2);

  if (!l1 || !l2) {
    console.error(`[Library] Cannot mark contradiction: one or both learnings not found`);
    return;
  }

  // Add to contradicts arrays
  l1.contradicts = l1.contradicts || [];
  l2.contradicts = l2.contradicts || [];

  if (!l1.contradicts.includes(id2)) l1.contradicts.push(id2);
  if (!l2.contradicts.includes(id1)) l2.contradicts.push(id1);

  l1.updatedAt = new Date().toISOString();
  l2.updatedAt = new Date().toISOString();

  saveLearnings(learnings);
  console.log(`[Library] Marked contradiction between ${id1} and ${id2}`);
}

// ============================================================================
// Strategy Sync
// ============================================================================

/**
 * Sync strategies based on learning updates.
 * Called automatically when a learning with updatesStrategy is modified.
 */
function syncStrategiesFromLearning(learning: Learning): void {
  if (!learning.updatesStrategy || learning.updatesStrategy.length === 0) {
    return;
  }

  // Load strategies file
  const strategiesFile = path.join(STATE_DIR, 'trading/strategies.json');
  try {
    const strategiesData = JSON.parse(fs.readFileSync(strategiesFile, 'utf-8'));

    for (const strategyId of learning.updatesStrategy) {
      const strategy = strategiesData.strategies?.find((s: { id: string }) => s.id === strategyId);
      if (strategy) {
        // Add reference to the learning
        strategy.informedBy = strategy.informedBy || [];
        if (!strategy.informedBy.includes(learning.id)) {
          strategy.informedBy.push(learning.id);
        }
        strategy.lastLearningUpdate = new Date().toISOString();

        console.log(`[Library] Synced learning ${learning.id} to strategy ${strategyId}`);
      }
    }

    fs.writeFileSync(strategiesFile, JSON.stringify(strategiesData, null, 2));
  } catch (error) {
    console.error(`[Library] Failed to sync strategies:`, error);
  }
}

// ============================================================================
// Helper: Extract tags from content
// ============================================================================

const COMMON_TAGS = [
  'momentum', 'arbitrage', 'spread', 'liquidity', 'volatility',
  'market-maker', 'mm', 'sports', 'crypto', 'politics', 'election',
  'contrarian', 'mean-reversion', 'trend', 'overpriced', 'underpriced',
  'tail-risk', 'edge', 'mispricing', 'polymarket', 'closing',
  'leaderboard', 'top-traders', 'hft', 'high-frequency',
  'api', 'tooling', 'infrastructure', 'execution', 'slippage',
  'backtest', 'hypothesis', 'experiment', 'observation',
];

/**
 * Extract tags from content text.
 * Useful when migrating old learnings or auto-tagging new ones.
 */
export function extractTags(text: string): string[] {
  const lower = text.toLowerCase();
  return COMMON_TAGS.filter(tag => lower.includes(tag.replace('-', ' ')) || lower.includes(tag));
}

/**
 * Generate a claim from title and content.
 * Attempts to extract the key insight in one sentence.
 */
export function generateClaim(title: string, content: string): string {
  // If content has a "Key insight" or "Conclusion" section, extract it
  const keyInsightMatch = content.match(/\*\*Key [Ii]nsight\*\*:?\s*([^*\n]+)/);
  if (keyInsightMatch) {
    return keyInsightMatch[1].trim();
  }

  const conclusionMatch = content.match(/\*\*Conclusion\*\*:?\s*([^*\n]+)/);
  if (conclusionMatch) {
    return conclusionMatch[1].trim();
  }

  // Otherwise use the title as-is or first sentence of content
  if (title && title.length > 20) {
    return title;
  }

  const firstSentence = content.split(/[.!?]/)[0];
  if (firstSentence && firstSentence.length > 20) {
    return firstSentence.trim() + '.';
  }

  return title;
}
