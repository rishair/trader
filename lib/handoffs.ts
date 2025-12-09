import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

const HANDOFFS_FILE = path.join(__dirname, '../state/orchestrator/handoffs.json');

export type Role = 'trade-research' | 'agent-engineer';

export type HandoffType =
  | 'build_capability'
  | 'fix_issue'
  | 'analysis_request'
  | 'trade_execution';

export type HandoffStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface Handoff {
  id: string;
  from: Role;
  to: Role;
  type: HandoffType;
  priority: 'low' | 'medium' | 'high' | 'critical';
  status: HandoffStatus;
  context: Record<string, unknown>;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  result: unknown | null;
}

interface HandoffsFile {
  handoffs: Handoff[];
}

function loadHandoffs(): HandoffsFile {
  try {
    const content = fs.readFileSync(HANDOFFS_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return { handoffs: [] };
  }
}

function saveHandoffs(data: HandoffsFile): void {
  fs.writeFileSync(HANDOFFS_FILE, JSON.stringify(data, null, 2));
}

/**
 * Create a new handoff request
 */
export function createHandoff(
  from: Role,
  to: Role,
  type: HandoffType,
  context: Record<string, unknown>,
  priority: Handoff['priority'] = 'medium'
): string {
  const data = loadHandoffs();
  const id = `handoff-${crypto.randomBytes(4).toString('hex')}`;

  const handoff: Handoff = {
    id,
    from,
    to,
    type,
    priority,
    status: 'pending',
    context,
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    result: null,
  };

  data.handoffs.push(handoff);
  saveHandoffs(data);

  return id;
}

/**
 * Get all pending handoffs for a specific role
 */
export function getPendingHandoffsFor(role: Role): Handoff[] {
  const data = loadHandoffs();
  return data.handoffs
    .filter(h => h.to === role && h.status === 'pending')
    .sort((a, b) => {
      // Sort by priority (critical > high > medium > low)
      const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });
}

/**
 * Get the next pending handoff (highest priority)
 */
export function getNextPendingHandoff(): Handoff | null {
  const data = loadHandoffs();
  const pending = data.handoffs
    .filter(h => h.status === 'pending')
    .sort((a, b) => {
      const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return priorityOrder[a.priority] - priorityOrder[b.priority];
    });

  return pending[0] || null;
}

/**
 * Mark a handoff as in progress
 */
export function startHandoff(id: string): boolean {
  const data = loadHandoffs();
  const handoff = data.handoffs.find(h => h.id === id);

  if (!handoff || handoff.status !== 'pending') {
    return false;
  }

  handoff.status = 'in_progress';
  handoff.startedAt = new Date().toISOString();
  saveHandoffs(data);

  return true;
}

/**
 * Complete a handoff with a result
 */
export function completeHandoff(id: string, result: unknown): boolean {
  const data = loadHandoffs();
  const handoff = data.handoffs.find(h => h.id === id);

  if (!handoff) {
    return false;
  }

  handoff.status = 'completed';
  handoff.completedAt = new Date().toISOString();
  handoff.result = result;
  saveHandoffs(data);

  return true;
}

/**
 * Fail a handoff with an error
 */
export function failHandoff(id: string, error: string): boolean {
  const data = loadHandoffs();
  const handoff = data.handoffs.find(h => h.id === id);

  if (!handoff) {
    return false;
  }

  handoff.status = 'failed';
  handoff.completedAt = new Date().toISOString();
  handoff.result = { error };
  saveHandoffs(data);

  return true;
}

/**
 * Get a specific handoff by ID
 */
export function getHandoff(id: string): Handoff | null {
  const data = loadHandoffs();
  return data.handoffs.find(h => h.id === id) || null;
}

/**
 * Clean up old completed/failed handoffs (keep last 50)
 */
export function cleanupHandoffs(): number {
  const data = loadHandoffs();
  const pending = data.handoffs.filter(h => h.status === 'pending' || h.status === 'in_progress');
  const completed = data.handoffs
    .filter(h => h.status === 'completed' || h.status === 'failed')
    .sort((a, b) => new Date(b.completedAt!).getTime() - new Date(a.completedAt!).getTime())
    .slice(0, 50);

  const removed = data.handoffs.length - (pending.length + completed.length);
  data.handoffs = [...pending, ...completed];
  saveHandoffs(data);

  return removed;
}

// ============================================================================
// Convenience Functions for Common Handoff Patterns
// ============================================================================

/**
 * Request a capability from Agent Engineer.
 * Use when Trade Research is blocked and needs infrastructure.
 */
export function requestCapability(
  description: string,
  context: Record<string, unknown> = {},
  priority: 'low' | 'medium' | 'high' = 'medium'
): string {
  return createHandoff(
    'trade-research',
    'agent-engineer',
    'build_capability',
    { description, ...context },
    priority
  );
}

/**
 * Request analysis from Trade Research.
 * Use when Agent Engineer needs trading insight.
 */
export function requestAnalysis(
  question: string,
  context: Record<string, unknown> = {},
  priority: 'low' | 'medium' | 'high' = 'medium'
): string {
  return createHandoff(
    'agent-engineer',
    'trade-research',
    'analysis_request',
    { question, ...context },
    priority
  );
}

/**
 * Report an issue that needs fixing.
 */
export function reportIssue(
  from: Role,
  description: string,
  context: Record<string, unknown> = {},
  priority: 'low' | 'medium' | 'high' | 'critical' = 'medium'
): string {
  return createHandoff(
    from,
    'agent-engineer',
    'fix_issue',
    { description, ...context },
    priority
  );
}

/**
 * Get a human-readable summary of pending handoffs.
 */
export function getHandoffsSummary(): string {
  const data = loadHandoffs();
  const pending = data.handoffs.filter(h => h.status === 'pending');
  const inProgress = data.handoffs.filter(h => h.status === 'in_progress');

  if (pending.length === 0 && inProgress.length === 0) {
    return 'No pending handoffs.';
  }

  const lines: string[] = [];

  if (inProgress.length > 0) {
    lines.push(`**In Progress (${inProgress.length}):**`);
    for (const h of inProgress) {
      lines.push(`- [${h.type}] ${h.from} → ${h.to}: ${(h.context.description as string || 'No description').slice(0, 60)}`);
    }
  }

  if (pending.length > 0) {
    lines.push(`**Pending (${pending.length}):**`);
    for (const h of pending.slice(0, 5)) {
      lines.push(`- [${h.priority}] ${h.from} → ${h.to}: ${(h.context.description as string || h.context.question as string || 'No description').slice(0, 60)}`);
    }
    if (pending.length > 5) {
      lines.push(`  ...and ${pending.length - 5} more`);
    }
  }

  return lines.join('\n');
}
