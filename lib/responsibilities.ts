import * as fs from 'fs';
import * as path from 'path';

const RESPONSIBILITIES_FILE = path.join(__dirname, '../state/orchestrator/responsibilities.json');

export type Role = 'trade-research' | 'agent-engineer';

export interface Responsibility {
  frequency: string; // e.g., "4h", "24h", "7d"
  lastRun: string | null;
}

export interface ResponsibilitiesFile {
  [role: string]: {
    [responsibilityName: string]: Responsibility;
  };
}

function loadResponsibilities(): ResponsibilitiesFile {
  try {
    const content = fs.readFileSync(RESPONSIBILITIES_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

function saveResponsibilities(data: ResponsibilitiesFile): void {
  fs.writeFileSync(RESPONSIBILITIES_FILE, JSON.stringify(data, null, 2));
}

/**
 * Parse frequency string to milliseconds
 * Supports: "30m", "4h", "24h", "7d"
 */
function parseFrequency(freq: string): number {
  const match = freq.match(/^(\d+)(m|h|d)$/);
  if (!match) {
    throw new Error(`Invalid frequency format: ${freq}`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 'm':
      return value * 60 * 1000;
    case 'h':
      return value * 60 * 60 * 1000;
    case 'd':
      return value * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`Unknown frequency unit: ${unit}`);
  }
}

export interface DueResponsibility {
  role: Role;
  name: string;
  frequency: string;
  lastRun: string | null;
  overdueBy: number; // milliseconds overdue
}

/**
 * Get the next responsibility that is due
 * Returns the most overdue responsibility first
 */
export function getNextDueResponsibility(): DueResponsibility | null {
  const data = loadResponsibilities();
  const now = Date.now();
  const dueResponsibilities: DueResponsibility[] = [];

  for (const [role, responsibilities] of Object.entries(data)) {
    for (const [name, resp] of Object.entries(responsibilities)) {
      const frequencyMs = parseFrequency(resp.frequency);
      const lastRunTime = resp.lastRun ? new Date(resp.lastRun).getTime() : 0;
      const nextDue = lastRunTime + frequencyMs;

      if (now >= nextDue) {
        dueResponsibilities.push({
          role: role as Role,
          name,
          frequency: resp.frequency,
          lastRun: resp.lastRun,
          overdueBy: now - nextDue,
        });
      }
    }
  }

  // Sort by most overdue first
  dueResponsibilities.sort((a, b) => b.overdueBy - a.overdueBy);

  return dueResponsibilities[0] || null;
}

/**
 * Get all due responsibilities for a specific role
 */
export function getDueResponsibilitiesFor(role: Role): DueResponsibility[] {
  const data = loadResponsibilities();
  const now = Date.now();
  const dueResponsibilities: DueResponsibility[] = [];

  const roleData = data[role];
  if (!roleData) return [];

  for (const [name, resp] of Object.entries(roleData)) {
    const frequencyMs = parseFrequency(resp.frequency);
    const lastRunTime = resp.lastRun ? new Date(resp.lastRun).getTime() : 0;
    const nextDue = lastRunTime + frequencyMs;

    if (now >= nextDue) {
      dueResponsibilities.push({
        role,
        name,
        frequency: resp.frequency,
        lastRun: resp.lastRun,
        overdueBy: now - nextDue,
      });
    }
  }

  return dueResponsibilities.sort((a, b) => b.overdueBy - a.overdueBy);
}

/**
 * Mark a responsibility as completed (update lastRun)
 */
export function markResponsibilityComplete(role: Role, name: string): boolean {
  const data = loadResponsibilities();

  if (!data[role] || !data[role][name]) {
    return false;
  }

  data[role][name].lastRun = new Date().toISOString();
  saveResponsibilities(data);

  return true;
}

/**
 * Get status of all responsibilities
 */
export function getResponsibilityStatus(): {
  role: string;
  name: string;
  frequency: string;
  lastRun: string | null;
  nextDue: string;
  isDue: boolean;
}[] {
  const data = loadResponsibilities();
  const now = Date.now();
  const status: ReturnType<typeof getResponsibilityStatus> = [];

  for (const [role, responsibilities] of Object.entries(data)) {
    for (const [name, resp] of Object.entries(responsibilities)) {
      const frequencyMs = parseFrequency(resp.frequency);
      const lastRunTime = resp.lastRun ? new Date(resp.lastRun).getTime() : 0;
      const nextDueTime = lastRunTime + frequencyMs;

      status.push({
        role,
        name,
        frequency: resp.frequency,
        lastRun: resp.lastRun,
        nextDue: new Date(nextDueTime).toISOString(),
        isDue: now >= nextDueTime,
      });
    }
  }

  return status;
}
