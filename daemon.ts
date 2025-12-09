import { execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import axios from 'axios';
import {
  getNextDueResponsibility,
  markResponsibilityComplete,
  DueResponsibility
} from './lib/responsibilities';
import {
  getNextPendingHandoff,
  startHandoff,
  completeHandoff,
  Handoff
} from './lib/handoffs';
import { sendCommitNotification } from './tools/telegram/bot';
import {
  getStrategicDecision,
  detectPriorities,
  getExecutionMetrics,
  Priority
} from './lib/orchestrator';
import {
  buildTradeResearchContext,
  buildAgentEngineerContext,
  prepareQuickStatusContext
} from './lib/context';
import { exitPosition, loadPortfolio } from './lib/trading';
import {
  executeAndWait,
  executeWithStreaming,
  executeAgentByRole,
  collectOutput,
  AGENTS,
} from './lib/agent-sdk';

dotenv.config();

// Capture version at startup (won't change until restart)
const DAEMON_VERSION = execSync('git rev-parse --short HEAD', { cwd: __dirname, encoding: 'utf-8' }).trim();
const DAEMON_START_TIME = new Date().toISOString();

const STATE_DIR = path.join(__dirname, 'state');
const ENGINE_STATUS_FILE_PATH = path.join(STATE_DIR, 'engine-status.json');
const CHAT_ID_FILE = path.join(STATE_DIR, 'telegram_chat_id.txt');
const ENGINE_STATUS_FILE = path.join(STATE_DIR, 'trading/engine-status.json');
const HYPOTHESES_FILE = path.join(STATE_DIR, 'trading/hypotheses.json');

// Agent types
type AgentRole = 'trade-research' | 'agent-engineer';

function getTelegramChatId(): string | null {
  try {
    return fs.readFileSync(CHAT_ID_FILE, 'utf-8').trim();
  } catch {
    return null;
  }
}

async function sendTelegramAlert(message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = getTelegramChatId();
  if (!token || !chatId) return;

  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: message,
      parse_mode: 'Markdown',
    });
  } catch (error: any) {
    log(`Failed to send Telegram alert: ${error.message}`);
  }
}
const SCHEDULE_FILE = path.join(STATE_DIR, 'orchestrator/schedule.json');
const LOG_DIR = path.join(STATE_DIR, 'logs');

interface ScheduledTask {
  id: string;
  type: string;
  description: string;
  scheduledFor: string;
  priority: string;
  context: Record<string, unknown>;
}

interface Schedule {
  pendingTasks: ScheduledTask[];
  completedTasks: ScheduledTask[];
}

function log(message: string): void {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;
  console.log(logMessage);

  const logFile = path.join(LOG_DIR, `daemon-${new Date().toISOString().split('T')[0]}.log`);
  fs.appendFileSync(logFile, logMessage + '\n');
}

function gitPull(): boolean {
  try {
    log('Pulling latest from origin...');
    execSync('git pull origin main', { cwd: __dirname, stdio: 'pipe' });
    log('Git pull successful');
    return true;
  } catch (error: any) {
    log(`Git pull failed: ${error.message}`);
    return false;
  }
}

async function gitPush(): Promise<boolean> {
  try {
    log('Checking for changes to push...');
    const status = execSync('git status --porcelain', { cwd: __dirname, encoding: 'utf-8' });

    if (status.trim()) {
      log('Changes detected, committing and pushing...');
      execSync('git add -A', { cwd: __dirname, stdio: 'pipe' });
      execSync('git commit -m "Auto-commit: daemon task execution"', { cwd: __dirname, stdio: 'pipe' });

      // Get the commit hash for notification
      const commitHash = execSync('git rev-parse --short HEAD', { cwd: __dirname, encoding: 'utf-8' }).trim();

      execSync('git push origin main', { cwd: __dirname, stdio: 'pipe' });
      log('Git push successful');

      // Notify with GitHub link
      await sendCommitNotification(commitHash, 'Auto-commit: daemon task execution');
    } else {
      log('No changes to push');
    }
    return true;
  } catch (error: any) {
    log(`Git push failed: ${error.message}`);
    return false;
  }
}

function loadSchedule(): Schedule {
  try {
    const content = fs.readFileSync(SCHEDULE_FILE, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    log(`Error loading schedule: ${error}`);
    return { pendingTasks: [], completedTasks: [] };
  }
}

function saveSchedule(schedule: Schedule): void {
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2));
}

// Pipeline registry - maps pipeline names to their scripts
const PIPELINES: Record<string, string> = {
  'closing-scanner': 'tools/pipelines/closing-scanner.ts',
  'health-check': 'tools/pipelines/health-check.ts',
  'leaderboard-tracker': 'tools/pipelines/leaderboard-tracker.ts',
  'daily-briefing': 'tools/pipelines/daily-briefing.ts',
  'price-drift-detector': 'tools/pipelines/price-drift-detector.ts',
  'hypothesis-tester': 'tools/pipelines/hypothesis-tester.ts',
  'price-tracker': 'tools/pipelines/price-tracker.ts',
  'trade-retrospective': 'tools/pipelines/trade-retrospective.ts',
};

// Recurring pipeline configuration - pipelines that should always have a future task
interface RecurringPipeline {
  name: string;
  frequency: string;
  description: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
}

const RECURRING_PIPELINES: RecurringPipeline[] = [
  { name: 'closing-scanner', frequency: '6h', description: 'Closing-soon scanner: Find markets closing in 72h, check momentum, generate hypotheses', priority: 'high' },
  { name: 'health-check', frequency: '12h', description: 'Health check: Analyze system state, propose actions for user approval', priority: 'high' },
  { name: 'leaderboard-tracker', frequency: '24h', description: 'Leaderboard tracker: Track top traders, analyze positions, generate follow signals', priority: 'high' },
  { name: 'daily-briefing', frequency: '24h', description: 'Daily briefing: Send CEO summary via Telegram, ask for priorities', priority: 'high' },
  // KILLED 2025-12-09: price-drift-detector - no edge in momentum chasing. Academic research shows noise traders cause reversals, not continuation.
  { name: 'hypothesis-tester', frequency: '4h', description: 'Hypothesis tester: Monitor entry/exit conditions, execute trades, track results', priority: 'high' },
  { name: 'price-tracker', frequency: '1h', description: 'Price tracker: Update portfolio prices, check exit triggers', priority: 'critical' },
  { name: 'trade-retrospective', frequency: '6h', description: 'Trade retrospective: Analyze resolved trades, update confidence, add learnings', priority: 'medium' },
];

/**
 * Ensure all recurring pipelines have at least one future task scheduled
 */
function ensurePipelinesScheduled(schedule: Schedule): boolean {
  let changed = false;
  const now = new Date();

  for (const pipeline of RECURRING_PIPELINES) {
    // Check if there's already a pending task for this pipeline
    const existingTask = schedule.pendingTasks.find(
      t => t.type === 'pipeline' && t.context?.pipeline === pipeline.name
    );

    if (!existingTask) {
      // No pending task - schedule one
      const frequencyMs = parseFrequency(pipeline.frequency);
      const scheduledFor = new Date(now.getTime() + frequencyMs);

      const newTask: ScheduledTask = {
        id: `pipeline-${pipeline.name}-${Date.now()}`,
        type: 'pipeline',
        description: pipeline.description,
        scheduledFor: scheduledFor.toISOString(),
        priority: pipeline.priority,
        context: {
          pipeline: pipeline.name,
          recurring: true,
          frequency: pipeline.frequency,
        }
      };

      schedule.pendingTasks.push(newTask);
      log(`Scheduled missing pipeline: ${pipeline.name} for ${scheduledFor.toISOString()}`);
      changed = true;
    }
  }

  return changed;
}

async function executePipeline(pipelineName: string): Promise<{ success: boolean; output: string }> {
  const scriptPath = PIPELINES[pipelineName];
  if (!scriptPath) {
    return { success: false, output: `Unknown pipeline: ${pipelineName}` };
  }

  return new Promise((resolve) => {
    const fullPath = path.join(__dirname, scriptPath);
    log(`Running pipeline: ${pipelineName} (${fullPath})`);

    const proc = spawn('npx', ['ts-node', fullPath], {
      cwd: __dirname,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code: number) => {
      resolve({
        success: code === 0,
        output: stdout || stderr
      });
    });

    proc.on('error', (error: Error) => {
      resolve({ success: false, output: error.message });
    });
  });
}

/**
 * Spawn an agent for a responsibility using Agent SDK
 * Uses focused context from lib/context.ts instead of full state files
 */
async function executeResponsibility(resp: DueResponsibility): Promise<void> {
  log(`Executing responsibility: ${resp.role}/${resp.name}`);
  await sendTelegramAlert(`🔄 *${resp.role}*\nRunning: ${resp.name}`);

  const sessionLogFile = path.join(LOG_DIR, `responsibility-${resp.role}-${resp.name}-${Date.now()}.log`);

  // Get focused context for this specific responsibility
  const focusedContext = resp.role === 'trade-research'
    ? buildTradeResearchContext(resp.name)
    : buildAgentEngineerContext(resp.name);

  const agentName = resp.role === 'trade-research'
    ? 'Trade Research Engineer'
    : 'Agent Engineer';

  const prompt = `You are the ${agentName}.

## Responsibility: ${resp.name}

${focusedContext}

## Available Libraries

\`\`\`typescript
// Trading (handles validation, approval, state updates)
import { executePaperTrade, exitPosition, getPortfolioSummary } from './lib/trading';

// Hypotheses (handles state machine, transitions, evidence)
import { transitionHypothesis, addEvidence, blockHypothesis, createHypothesis } from './lib/hypothesis';
\`\`\`

## Guidelines
- Focus on the task above - don't read full state files unless necessary
- Use the libraries - they handle validation and state updates
- Be action-oriented - make decisions, don't just observe
- Be concise - this is one responsibility, not a full session

Last run: ${resp.lastRun || 'never'}
`;

  let output = '';
  try {
    const { result, success, costUsd, durationMs } = await executeWithStreaming(
      prompt,
      (message) => {
        // Stream output to console
        if (message.type === 'assistant' && message.message?.content) {
          for (const block of message.message.content) {
            if ('text' in block && block.text) {
              process.stdout.write(block.text);
              output = block.text;
            }
          }
        }
      },
      {
        model: resp.role === 'trade-research'
          ? 'claude-sonnet-4-5-20250929'
          : 'claude-sonnet-4-5-20250929',
      }
    );

    fs.writeFileSync(sessionLogFile, output || result);
    log(`Responsibility ${resp.role}/${resp.name} completed (cost: $${costUsd.toFixed(4)}, time: ${(durationMs / 1000).toFixed(1)}s)`);

    if (success) {
      markResponsibilityComplete(resp.role, resp.name);
      await sendTelegramAlert(`✅ *${resp.role}*\nCompleted: ${resp.name}`);
    } else {
      await sendTelegramAlert(`❌ *${resp.role}*\nFailed: ${resp.name}`);
      throw new Error(`Responsibility failed: ${result}`);
    }
  } catch (error: any) {
    log(`Error executing responsibility: ${error.message}`);
    await sendTelegramAlert(`❌ *${resp.role}*\nFailed: ${resp.name}\n${error.message}`);
    throw error;
  }
}

/**
 * Spawn an agent for a handoff using Agent SDK
 */
async function executeHandoff(handoff: Handoff): Promise<void> {
  log(`Executing handoff: ${handoff.id} (${handoff.type}) for ${handoff.to}`);
  await sendTelegramAlert(`📤 *Handoff*\n${handoff.from} → ${handoff.to}\nType: ${handoff.type}`);

  startHandoff(handoff.id);
  const sessionLogFile = path.join(LOG_DIR, `handoff-${handoff.id}-${Date.now()}.log`);

  const prompt = `You are the ${handoff.to === 'trade-research' ? 'Trade Research Engineer' : 'Agent Engineer'}.

## Handoff Request

You have a handoff request from ${handoff.from}:

Type: ${handoff.type}
Priority: ${handoff.priority}
Context: ${JSON.stringify(handoff.context, null, 2)}

## Instructions
1. Complete the handoff request based on your role
2. Update state files as needed
3. Return a clear result with what you accomplished

The result of this handoff will be recorded for ${handoff.from} to see.
`;

  let output = '';
  try {
    const { result, success, costUsd, durationMs } = await executeWithStreaming(
      prompt,
      (message) => {
        if (message.type === 'assistant' && message.message?.content) {
          for (const block of message.message.content) {
            if ('text' in block && block.text) {
              process.stdout.write(block.text);
              output = block.text;
            }
          }
        }
      },
      {
        model: 'claude-sonnet-4-5-20250929',
      }
    );

    fs.writeFileSync(sessionLogFile, output || result);
    log(`Handoff ${handoff.id} completed (cost: $${costUsd.toFixed(4)}, time: ${(durationMs / 1000).toFixed(1)}s)`);

    if (success) {
      const resultSummary = (output || result).slice(-300);
      completeHandoff(handoff.id, { success: true, output: (output || result).slice(-500) });
      await sendTelegramAlert(
        `✅ *Handoff completed*\n\n` +
        `*Type:* ${handoff.type}\n` +
        `*From:* ${handoff.from} → ${handoff.to}\n` +
        `*Context:* ${JSON.stringify(handoff.context).slice(0, 100)}...\n\n` +
        `*Result:*\n${resultSummary.slice(0, 200)}...`
      );
    } else {
      completeHandoff(handoff.id, { success: false, error: result });
      await sendTelegramAlert(
        `❌ *Handoff failed*\n\n` +
        `*Type:* ${handoff.type}\n` +
        `*From:* ${handoff.from}\n` +
        `*Error:* ${result.slice(0, 200)}`
      );
      throw new Error(`Handoff failed: ${result}`);
    }
  } catch (error: any) {
    log(`Error executing handoff: ${error.message}`);
    completeHandoff(handoff.id, { success: false, error: error.message });
    await sendTelegramAlert(
      `❌ *Handoff failed*\n\n` +
      `*Type:* ${handoff.type}\n` +
      `*From:* ${handoff.from}\n` +
      `*Error:* ${error.message.slice(0, 200)}`
    );
    throw error;
  }
}

/**
 * Execute a code-only priority (no model needed)
 * These are deterministic actions that code can handle
 */
async function executeCodePriority(priority: Priority): Promise<void> {
  log(`Executing code priority: ${priority.action}`);

  switch (priority.action) {
    case 'execute-stop-loss': {
      const { positionId, currentPrice } = priority.context;
      log(`Executing stop loss for ${positionId} at ${currentPrice}`);
      await exitPosition(positionId, currentPrice, 'Stop loss triggered');
      await sendTelegramAlert(
        `🛑 *Stop Loss Executed*\nPosition: ${positionId}\nPrice: ${(currentPrice * 100).toFixed(1)}¢`
      );
      break;
    }

    case 'execute-take-profit': {
      const { positionId, currentPrice } = priority.context;
      log(`Executing take profit for ${positionId} at ${currentPrice}`);
      await exitPosition(positionId, currentPrice, 'Take profit triggered');
      await sendTelegramAlert(
        `🎯 *Take Profit Executed*\nPosition: ${positionId}\nPrice: ${(currentPrice * 100).toFixed(1)}¢`
      );
      break;
    }

    default:
      log(`Unknown code priority action: ${priority.action}`);
  }
}

/**
 * Execute a focused agent with minimal, task-specific context using Agent SDK
 * Instead of loading full state files, we give the model exactly what it needs
 */
async function executeFocusedAgent(priority: Priority): Promise<void> {
  log(`Executing focused agent: ${priority.action} for ${priority.agentRole}`);
  await sendTelegramAlert(
    `🎯 *Focused Task*\n${priority.action}\nUrgency: ${priority.urgency}`
  );

  const sessionLogFile = path.join(LOG_DIR, `focused-${priority.action}-${Date.now()}.log`);

  // Build minimal prompt with focused context
  const agentName = priority.agentRole === 'trade-research'
    ? 'Trade Research Engineer'
    : 'Agent Engineer';

  const prompt = `You are the ${agentName}.

## Urgent Task: ${priority.action}

${priority.focusedPrompt}

## Available Libraries

\`\`\`typescript
// Trading (handles validation, approval, state)
import { executePaperTrade, exitPosition, getPortfolioSummary } from './lib/trading';

// Hypotheses (handles state machine, transitions)
import { transitionHypothesis, addEvidence, blockHypothesis } from './lib/hypothesis';
\`\`\`

## Instructions
1. Focus ONLY on the task above
2. Make a decision and execute it
3. Be concise - this is a focused intervention, not a full session
`;

  let output = '';
  try {
    const { result, success, costUsd, durationMs } = await executeWithStreaming(
      prompt,
      (message) => {
        if (message.type === 'assistant' && message.message?.content) {
          for (const block of message.message.content) {
            if ('text' in block && block.text) {
              process.stdout.write(block.text);
              output = block.text;
            }
          }
        }
      },
      {
        model: 'claude-sonnet-4-5-20250929',
      }
    );

    fs.writeFileSync(sessionLogFile, output || result);
    log(`Focused agent ${priority.action} completed (cost: $${costUsd.toFixed(4)}, time: ${(durationMs / 1000).toFixed(1)}s)`);

    if (success) {
      await sendTelegramAlert(`✅ *Focused task completed*\n${priority.action}`);
    } else {
      await sendTelegramAlert(`❌ *Focused task failed*\n${priority.action}`);
      throw new Error(`Focused agent failed: ${result}`);
    }
  } catch (error: any) {
    log(`Error executing focused agent: ${error.message}`);
    await sendTelegramAlert(`❌ *Focused task failed*\n${priority.action}\n${error.message}`);
    throw error;
  }
}

/**
 * Update engine status - can be called externally for event-driven updates
 */
export function updateEngineStatus(): void {
  try {
    const hypotheses = JSON.parse(fs.readFileSync(HYPOTHESES_FILE, 'utf-8'));
    const engineStatus = JSON.parse(fs.readFileSync(ENGINE_STATUS_FILE, 'utf-8'));

    // Recalculate hypothesis health
    const hypList = hypotheses.hypotheses || [];
    engineStatus.hypothesisHealth.total = hypList.length;
    engineStatus.hypothesisHealth.byStatus = {
      proposed: hypList.filter((h: any) => h.status === 'proposed').length,
      testing: hypList.filter((h: any) => h.status === 'testing').length,
      validated: hypList.filter((h: any) => h.status === 'validated').length,
      invalidated: hypList.filter((h: any) => h.status === 'invalidated').length
    };

    // Calculate testable hypotheses with stricter criteria:
    // - Status is 'proposed' or 'testing'
    // - Not in blocked list
    // - Confidence > 0.30 (below this, should be killed or needs more research)
    // - If testing, must have linkedTrade or recent activity
    const blockedIds = engineStatus.blockedHypotheses.map((b: any) => b.hypothesisId);
    const testableHypotheses = hypList.filter((h: any) => {
      if (!['proposed', 'testing'].includes(h.status)) return false;
      if (blockedIds.includes(h.id)) return false;
      if (h.confidence <= 0.30) return false;
      return true;
    });
    engineStatus.hypothesisHealth.testableNow = testableHypotheses.length;
    engineStatus.hypothesisHealth.testableIds = testableHypotheses.map((h: any) => h.id);

    // Identify hypotheses that need attention
    const needsAttention: any[] = [];

    for (const h of hypList) {
      // Low confidence but still active - should kill or research more
      if (['proposed', 'testing'].includes(h.status) && h.confidence <= 0.30) {
        needsAttention.push({
          hypothesisId: h.id,
          issue: 'low_confidence',
          detail: `Confidence ${(h.confidence * 100).toFixed(0)}% - consider invalidating or gathering more evidence`,
          suggestedAction: h.evidence?.length >= 3 ? 'invalidate' : 'research'
        });
      }

      // Testing for too long without results
      if (h.status === 'testing' && h.testStartedAt) {
        const daysTesting = (Date.now() - new Date(h.testStartedAt).getTime()) / (1000 * 60 * 60 * 24);
        if (daysTesting > 14 && (!h.testResults || h.testResults.trades < 5)) {
          needsAttention.push({
            hypothesisId: h.id,
            issue: 'stale_test',
            detail: `Testing for ${daysTesting.toFixed(0)} days with insufficient data`,
            suggestedAction: 'review'
          });
        }
      }
    }

    engineStatus.needsAttention = needsAttention;

    // Determine engine state
    const testable = engineStatus.hypothesisHealth.testableNow;
    if (testable < 3) {
      engineStatus.engineState = 'starved';
    } else if (testable > 10) {
      engineStatus.engineState = 'saturated';
    } else {
      engineStatus.engineState = 'healthy';
    }

    engineStatus.lastEvaluated = new Date().toISOString();
    fs.writeFileSync(ENGINE_STATUS_FILE, JSON.stringify(engineStatus, null, 2));
    log(`Engine status updated: ${engineStatus.engineState} (${testable} testable: ${engineStatus.hypothesisHealth.testableIds?.join(', ') || 'none'})`);

    if (needsAttention.length > 0) {
      log(`Hypotheses needing attention: ${needsAttention.map(n => n.hypothesisId).join(', ')}`);
    }
  } catch (error: any) {
    log(`Failed to update engine status: ${error.message}`);
  }
}

function updateDaemonStatus(): void {
  try {
    const engineStatus = JSON.parse(fs.readFileSync(ENGINE_STATUS_FILE, 'utf-8'));
    engineStatus.daemon = {
      version: DAEMON_VERSION,
      startedAt: DAEMON_START_TIME,
      pid: process.pid,
    };
    fs.writeFileSync(ENGINE_STATUS_FILE, JSON.stringify(engineStatus, null, 2));
    log(`Daemon status written: version=${DAEMON_VERSION}, pid=${process.pid}`);
  } catch (error: any) {
    log(`Failed to update daemon status: ${error.message}`);
  }
}

function getNextTask(schedule: Schedule): ScheduledTask | null {
  const now = new Date();

  // Sort by scheduled time, then priority
  const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

  const dueTasks = schedule.pendingTasks
    .filter(task => new Date(task.scheduledFor) <= now)
    .sort((a, b) => {
      const timeDiff = new Date(a.scheduledFor).getTime() - new Date(b.scheduledFor).getTime();
      if (timeDiff !== 0) return timeDiff;
      return (priorityOrder[a.priority] || 2) - (priorityOrder[b.priority] || 2);
    });

  return dueTasks[0] || null;
}

function buildPrompt(task: ScheduledTask): string {
  return `You are waking up to execute a scheduled task.

## Your Mission
Read MISSION.md for your full operating instructions.

## Current Task
ID: ${task.id}
Type: ${task.type}
Description: ${task.description}
Priority: ${task.priority}
Context: ${JSON.stringify(task.context, null, 2)}

## Instructions
1. Load relevant state from state/ directory
2. Execute this task according to your mission
3. Update state files with any changes
4. Log your session summary to state/logs/
5. Update state/status.md with current status
6. Schedule any follow-up tasks by updating state/schedule.json
7. If you need to wake up again, add tasks to the schedule with appropriate times

Remember: You are autonomous. Make decisions, take actions, create tools if needed.
`;
}

async function executeTask(task: ScheduledTask): Promise<void> {
  log(`Executing task: ${task.id} - ${task.description}`);
  await sendTelegramAlert(`🚀 *Starting task*\n\`${task.id}\`\n${task.description}`);

  const sessionLogFile = path.join(LOG_DIR, `session-${task.id}-${Date.now()}.log`);

  // Handle autonomous wake tasks - orchestrator pattern
  // Phase 1: Read-only orchestrator decides what to do
  // Phase 2: Spawn the appropriate agent to execute
  if (task.type === 'autonomous') {
    log(`Executing autonomous wake task: ${task.id}`);

    // Phase 1: Orchestrator gathers context and decides
    const orchestratorPrompt = `You are the Orchestrator deciding what needs attention.

## Priority Checks (in order of importance)

1. **CEO-shared hypotheses** - Check state/trading/hypotheses.json for hypotheses with \`source: "ceo-shared"\` and \`status: "proposed"\`
   - These get HIGHEST priority - the CEO shared them for a reason
   - For each: evaluate against learnings, decide if should promote to testing
   - If promoting: agent should find linkedMarket using MCP tools if missing, then transition to testing

2. **Portfolio risks** - Stop losses about to trigger, positions needing attention

3. **Stuck hypotheses** - Testing too long without progress, low confidence items to kill

4. **System health** - Errors, issues to fix

## Files to Check
- state/trading/hypotheses.json - hypothesis health, stuck items, CEO-shared items
- state/trading/portfolio.json - positions, P&L, risks
- state/trading/engine-status.json - overall engine health
- state/trading/learnings.json - past learnings to inform decisions
- state/agent-engineering/health.json - system errors, issues
- state/orchestrator/handoffs.json - pending requests between agents

## Agent Responsibilities
- **trade-research**: Hypotheses, strategies, trades, market analysis, portfolio decisions
- **agent-engineer**: Tools, infrastructure, fixes, system improvements, capabilities

## Output Format (JSON only, no other text)
{
  "agent": "trade-research" | "agent-engineer",
  "task": "specific description of what needs doing",
  "context": { "key data the agent needs" },
  "priority": "high" | "medium" | "low",
  "rationale": "why this is the top priority right now"
}

You are READ-ONLY. Do not modify any files. Your only job is to decide and delegate.
`;

    let orchestratorOutput = '';
    try {
      // Phase 1: Get orchestrator decision (read-only, Opus for judgment)
      log('Phase 1: Orchestrator gathering context and deciding...');
      const { result: orchestratorResult, success: orchestratorSuccess, costUsd: orchestratorCost } = await executeWithStreaming(
        orchestratorPrompt,
        (message) => {
          if (message.type === 'assistant' && message.message?.content) {
            for (const block of message.message.content) {
              if ('text' in block && block.text) {
                process.stdout.write(block.text);
                orchestratorOutput = block.text;
              }
            }
          }
        },
        {
          model: 'claude-opus-4-20250514',
          tools: ['Read', 'Glob', 'Grep'], // Read-only tools
        }
      );

      if (!orchestratorSuccess) {
        throw new Error(`Orchestrator failed: ${orchestratorResult}`);
      }

      log(`Orchestrator decision (cost: $${orchestratorCost.toFixed(4)})`);

      // Parse the orchestrator's JSON decision
      // Extract JSON from the output (may have markdown code blocks)
      const jsonMatch = orchestratorOutput.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error(`Orchestrator did not return valid JSON: ${orchestratorOutput}`);
      }

      const decision = JSON.parse(jsonMatch[0]) as {
        agent: 'trade-research' | 'agent-engineer';
        task: string;
        context: Record<string, unknown>;
        priority: 'high' | 'medium' | 'low';
        rationale: string;
      };

      log(`Decision: ${decision.agent} - ${decision.task} (${decision.priority})`);
      fs.writeFileSync(sessionLogFile, `Orchestrator Decision:\n${JSON.stringify(decision, null, 2)}\n\n`);

      // Phase 2: Spawn the appropriate agent to execute
      log(`Phase 2: Spawning ${decision.agent} agent...`);
      await sendTelegramAlert(`🎯 *Orchestrator decided*\nAgent: ${decision.agent}\nTask: ${decision.task}\nPriority: ${decision.priority}`);

      const agentPrompt = `## Task from Orchestrator
${decision.task}

## Context
${JSON.stringify(decision.context, null, 2)}

## Priority: ${decision.priority}

## Rationale
${decision.rationale}

Execute this task. Use the appropriate libraries (lib/trading.ts, lib/hypothesis.ts, etc.) and update state files as needed.`;

      let agentOutput = '';
      const agentQuery = executeAgentByRole(
        decision.agent as 'trade-research' | 'agent-engineer',
        agentPrompt
      );

      for await (const message of agentQuery) {
        if (message.type === 'assistant' && message.message?.content) {
          for (const block of message.message.content) {
            if ('text' in block && block.text) {
              process.stdout.write(block.text);
              agentOutput = block.text;
            }
          }
        }
        if (message.type === 'result') {
          if (message.subtype === 'success') {
            agentOutput = message.result;
            log(`Agent completed (cost: $${message.total_cost_usd.toFixed(4)}, time: ${(message.duration_ms / 1000).toFixed(1)}s)`);
          } else {
            throw new Error(`Agent failed: ${message.errors?.join(', ')}`);
          }
        }
      }

      fs.appendFileSync(sessionLogFile, `\nAgent Output:\n${agentOutput}`);

      // Reschedule next autonomous wake
      if (task.context?.recurring && task.context?.frequency) {
        const schedule = loadSchedule();
        const frequencyMs = parseFrequency(task.context.frequency as string);
        const nextRun = new Date(Date.now() + frequencyMs);

        const newTask: ScheduledTask = {
          ...task,
          id: `autonomous-wake-${Date.now()}`,
          scheduledFor: nextRun.toISOString()
        };
        schedule.pendingTasks.push(newTask);
        saveSchedule(schedule);
        log(`Scheduled next autonomous wake for ${nextRun.toISOString()}`);
      }

      await sendTelegramAlert(`✅ *Autonomous wake completed*\n\`${task.id}\`\nAgent: ${decision.agent}`);

    } catch (error: any) {
      log(`Error executing autonomous task: ${error.message}`);
      await sendTelegramAlert(`❌ *Autonomous wake failed*\n\`${task.id}\`\n${error.message}`);
      throw error;
    }
    return;
  }

  // Handle pipeline tasks directly without spawning Claude
  if (task.type === 'pipeline' && task.context?.pipeline) {
    const pipelineName = task.context.pipeline as string;
    log(`Executing pipeline: ${pipelineName}`);

    const result = await executePipeline(pipelineName);
    fs.writeFileSync(sessionLogFile, result.output);

    if (result.success) {
      log(`Pipeline ${pipelineName} completed successfully`);

      // Parse output to get summary
      try {
        const pipelineOutput = JSON.parse(result.output);

        // Different summaries for different pipelines
        let summary = '';
        if (pipelineName === 'closing-scanner') {
          summary = `Scanned ${pipelineOutput.marketsScanned} markets, found ${pipelineOutput.candidatesFound} candidates, generated ${pipelineOutput.hypothesesGenerated?.length || 0} hypotheses`;
        } else if (pipelineName === 'health-check') {
          summary = pipelineOutput.summary || `Found ${pipelineOutput.issuesFound} issues`;
          if (pipelineOutput.proposalsCreated > 0) {
            summary += `\n\n📋 *${pipelineOutput.proposalsCreated} proposals awaiting approval*\nUse /pending to review`;
          }
        } else {
          summary = pipelineOutput.summary || 'Completed';
        }

        await sendTelegramAlert(`✅ *Pipeline completed*\n\`${task.id}\`\n${summary}`);
      } catch {
        await sendTelegramAlert(`✅ *Pipeline completed*\n\`${task.id}\``);
      }

      // Reschedule if recurring
      if (task.context?.recurring && task.context?.frequency) {
        const schedule = loadSchedule();
        const frequencyMs = parseFrequency(task.context.frequency as string);
        const nextRun = new Date(Date.now() + frequencyMs);

        const newTask: ScheduledTask = {
          ...task,
          id: `${task.id.split('-').slice(0, -1).join('-')}-${Date.now()}`,
          scheduledFor: nextRun.toISOString()
        };
        schedule.pendingTasks.push(newTask);
        saveSchedule(schedule);
        log(`Rescheduled pipeline for ${nextRun.toISOString()}`);
      }

      return;
    } else {
      await sendTelegramAlert(`❌ *Pipeline failed*\n\`${task.id}\`\n${result.output.slice(0, 200)}`);
      throw new Error(`Pipeline ${pipelineName} failed: ${result.output}`);
    }
  }

  // For non-pipeline tasks, use Agent SDK
  const prompt = buildPrompt(task);

  let output = '';
  try {
    const { result, success, costUsd, durationMs } = await executeWithStreaming(
      prompt,
      (message) => {
        if (message.type === 'assistant' && message.message?.content) {
          for (const block of message.message.content) {
            if ('text' in block && block.text) {
              process.stdout.write(block.text);
              output = block.text;
            }
          }
        }
      },
      {
        model: 'claude-sonnet-4-5-20250929',
      }
    );

    fs.writeFileSync(sessionLogFile, output || result);
    log(`Task ${task.id} completed (cost: $${costUsd.toFixed(4)}, time: ${(durationMs / 1000).toFixed(1)}s)`);

    if (success) {
      await sendTelegramAlert(`✅ *Task completed*\n\`${task.id}\``);
    } else {
      await sendTelegramAlert(`❌ *Task failed*\n\`${task.id}\`\n${result}`);
      throw new Error(`Task failed: ${result}`);
    }
  } catch (error: any) {
    log(`Error executing task: ${error.message}`);
    await sendTelegramAlert(`❌ *Task failed*\n\`${task.id}\`\n${error.message}`);
    throw error;
  }
}

function parseFrequency(freq: string): number {
  const match = freq.match(/^(\d+)(h|m|d)$/);
  if (!match) return 6 * 60 * 60 * 1000; // Default 6 hours

  const value = parseInt(match[1]);
  const unit = match[2];

  switch (unit) {
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    default: return 6 * 60 * 60 * 1000;
  }
}

function markTaskComplete(schedule: Schedule, taskId: string, success: boolean = true, error?: string): void {
  const taskIndex = schedule.pendingTasks.findIndex(t => t.id === taskId);
  if (taskIndex !== -1) {
    const task = schedule.pendingTasks.splice(taskIndex, 1)[0];
    schedule.completedTasks.push({
      ...task,
      completedAt: new Date().toISOString(),
      result: { success, error }
    } as ScheduledTask & { completedAt: string; result: { success: boolean; error?: string } });
  }
}

async function runDaemon(): Promise<void> {
  log(`Daemon starting... (version: ${DAEMON_VERSION})`);
  await sendTelegramAlert(`🤖 *Daemon started*\nVersion: \`${DAEMON_VERSION}\``);

  // Write daemon status to engine-status.json
  updateDaemonStatus();

  // Ensure log directory exists
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  const checkInterval = 30 * 60 * 1000; // Check every 30 minutes

  const tick = async () => {
    // Pull latest state before checking for tasks
    gitPull();

    // Update engine status on every tick
    updateEngineStatus();

    // =========================================================================
    // PRIORITY 0: Strategic Orchestrator - Event-driven priorities
    // =========================================================================
    // Check for high-urgency situations that should override scheduled work
    const strategicDecision = getStrategicDecision();

    if (strategicDecision.shouldOverride && strategicDecision.priority) {
      const priority = strategicDecision.priority;
      log(`Strategic override: ${priority.action} (urgency: ${priority.urgency})`);

      // Handle code-executable priorities (no model needed)
      if (!priority.spawnsAgent) {
        try {
          await executeCodePriority(priority);
          gitPush();
          return;
        } catch (error) {
          log(`Code priority failed: ${error}`);
          gitPush();
          return;
        }
      }

      // Handle model-required priorities with focused context
      if (priority.spawnsAgent && priority.focusedPrompt) {
        try {
          await executeFocusedAgent(priority);
          gitPush();
          return;
        } catch (error) {
          log(`Focused agent failed: ${error}`);
          gitPush();
          return;
        }
      }
    }

    // =========================================================================
    // PRIORITY 1: Check for due responsibilities
    // =========================================================================
    const dueResponsibility = getNextDueResponsibility();
    if (dueResponsibility) {
      try {
        await executeResponsibility(dueResponsibility);
        await gitPush();
        return; // One execution per tick
      } catch (error) {
        log(`Responsibility failed: ${error}`);
        await gitPush();
        return;
      }
    }

    // =========================================================================
    // PRIORITY 2: Check for pending handoffs
    // =========================================================================
    const pendingHandoff = getNextPendingHandoff();
    if (pendingHandoff) {
      try {
        await executeHandoff(pendingHandoff);
        await gitPush();
        return; // One execution per tick
      } catch (error) {
        log(`Handoff failed: ${error}`);
        await gitPush();
        return;
      }
    }

    // =========================================================================
    // PRIORITY 3: Check for scheduled tasks (pipelines)
    // =========================================================================
    const schedule = loadSchedule();

    // Ensure all recurring pipelines are scheduled
    if (ensurePipelinesScheduled(schedule)) {
      saveSchedule(schedule);
    }

    const task = getNextTask(schedule);

    if (task) {
      try {
        await executeTask(task);
        markTaskComplete(schedule, task.id, true);
        saveSchedule(schedule);
        await gitPush();
      } catch (error: any) {
        log(`Task ${task.id} failed: ${error}`);
        markTaskComplete(schedule, task.id, false, error?.message || String(error));
        saveSchedule(schedule);
        await gitPush();
      }
    }

    // Log status if nothing to do
    if (!task) {
      const metrics = getExecutionMetrics();
      log(`Tick complete. Velocity: ${metrics.velocityScore}, Trades (7d): ${metrics.tradesLast7Days}`);
    }
  };

  // Initial tick
  await tick();

  // Continue checking (main 30-min loop)
  setInterval(tick, checkInterval);

  // =========================================================================
  // CRITICAL SIGNAL FAST LOOP - 5 minute interval
  // =========================================================================
  // This runs more frequently to catch stop-loss and take-profit triggers
  // Only executes code priorities (no model spawning) to avoid interference
  const CRITICAL_INTERVAL = 5 * 60 * 1000; // 5 minutes

  const criticalTick = async () => {
    try {
      // Only check for code-executable critical priorities
      const priorities = detectPriorities();

      const critical = priorities.filter(p =>
        p.urgency >= 95 && !p.spawnsAgent
      );

      if (critical.length === 0) {
        return; // Nothing critical, skip silently
      }

      log(`[Critical] Found ${critical.length} critical signals`);

      for (const priority of critical) {
        log(`[Critical] Executing: ${priority.action} (urgency: ${priority.urgency})`);
        try {
          await executeCodePriority(priority);

          // Only push if there are actual changes
          const status = execSync('git status --porcelain', { cwd: __dirname, encoding: 'utf-8' });
          if (status.trim()) {
            await gitPush();
          }
        } catch (error) {
          log(`[Critical] Priority failed: ${error}`);
        }
      }
    } catch (error) {
      log(`[Critical] Fast loop error: ${error}`);
    }
  };

  // Start critical signal fast loop
  setInterval(criticalTick, CRITICAL_INTERVAL);
  log('Critical signal loop running (5 min interval)');

  log('Daemon running (30 min main loop, 5 min critical loop). Press Ctrl+C to stop.');
}

// CLI commands
const command = process.argv[2];

switch (command) {
  case 'start':
    runDaemon().catch(console.error);
    break;

  case 'status':
    const schedule = loadSchedule();
    console.log('\n=== Trader Agent Status ===\n');
    console.log(`Pending tasks: ${schedule.pendingTasks.length}`);
    console.log(`Completed tasks: ${schedule.completedTasks.length}`);
    console.log('\nPending:');
    schedule.pendingTasks.forEach(t => {
      console.log(`  [${t.priority}] ${t.id}: ${t.description}`);
      console.log(`         Scheduled: ${t.scheduledFor}`);
    });
    break;

  case 'trigger':
    // Manually trigger next task
    gitPull(); // Pull latest before executing
    const sched = loadSchedule();
    const nextTask = getNextTask(sched);
    if (nextTask) {
      executeTask(nextTask)
        .then(async () => {
          markTaskComplete(sched, nextTask.id, true);
          saveSchedule(sched);
          await gitPush(); // Push changes after completion
          console.log('Task completed');
        })
        .catch(async (err) => {
          console.error(err);
          markTaskComplete(sched, nextTask.id, false, err?.message || String(err));
          saveSchedule(sched);
          await gitPush(); // Still push any partial changes
        });
    } else {
      // Trigger first pending task regardless of schedule
      if (sched.pendingTasks.length > 0) {
        const task = sched.pendingTasks[0];
        executeTask(task)
          .then(async () => {
            markTaskComplete(sched, task.id, true);
            saveSchedule(sched);
            await gitPush(); // Push changes after completion
            console.log('Task completed');
          })
          .catch(async (err) => {
            console.error(err);
            markTaskComplete(sched, task.id, false, err?.message || String(err));
            saveSchedule(sched);
            await gitPush(); // Still push any partial changes
          });
      } else {
        console.log('No pending tasks');
      }
    }
    break;

  case 'query':
    // Interactive query mode using Agent SDK
    const queryPrompt = process.argv.slice(3).join(' ') || 'What is your current status?';
    (async () => {
      try {
        const { result, success } = await executeWithStreaming(
          `You are the trader agent. Read state/status.md and answer this query: ${queryPrompt}`,
          (message) => {
            if (message.type === 'assistant' && message.message?.content) {
              for (const block of message.message.content) {
                if ('text' in block && block.text) {
                  process.stdout.write(block.text);
                }
              }
            }
          },
          {
            model: 'claude-sonnet-4-5-20250929',
          }
        );
        if (!success) {
          console.error('\nQuery failed:', result);
          process.exit(1);
        }
        console.log(''); // Add newline after streaming output
      } catch (error: any) {
        console.error('Error executing query:', error.message);
        process.exit(1);
      }
    })();
    break;

  default:
    console.log(`
Trader Agent Daemon

Usage:
  npx ts-node daemon.ts start    - Start the daemon (runs continuously)
  npx ts-node daemon.ts status   - Show current status and pending tasks
  npx ts-node daemon.ts trigger  - Manually trigger the next task
  npx ts-node daemon.ts query <question> - Ask the agent a question
`);
}
