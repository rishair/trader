import { spawn, ChildProcess, execSync } from 'child_process';
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
  { name: 'price-drift-detector', frequency: '1h', description: 'Price drift detector: Monitor markets for sudden moves, generate follow signals', priority: 'high' },
  { name: 'hypothesis-tester', frequency: '4h', description: 'Hypothesis tester: Monitor entry/exit conditions, execute trades, track results', priority: 'high' },
  { name: 'price-tracker', frequency: '4h', description: 'Price tracker: Update portfolio prices, check exit triggers', priority: 'high' },
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
 * Spawn an agent for a responsibility
 */
async function executeResponsibility(resp: DueResponsibility): Promise<void> {
  log(`Executing responsibility: ${resp.role}/${resp.name}`);
  await sendTelegramAlert(`🔄 *${resp.role}*\nRunning: ${resp.name}`);

  const sessionLogFile = path.join(LOG_DIR, `responsibility-${resp.role}-${resp.name}-${Date.now()}.log`);

  const prompt = `You are the ${resp.role === 'trade-research' ? 'Trade Research Engineer' : 'Agent Engineer'}.

## Current Responsibility: ${resp.name}

You are being spawned to execute your "${resp.name}" responsibility.
Read your agent definition at .claude/agents/${resp.role}.md for full instructions on this responsibility.

## Key Instructions
1. Execute the ${resp.name} responsibility as defined in your agent prompt
2. Update your owned state files with any changes
3. Log improvement ideas if you notice any friction
4. Be concise and action-oriented

## Context
Last run: ${resp.lastRun || 'never'}
Frequency: ${resp.frequency}
`;

  return new Promise((resolve, reject) => {
    const claude = spawn('claude', [
      '-p', prompt,
      '--output-format', 'text',
      '--dangerously-skip-permissions'
    ], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    let output = '';

    claude.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      output += text;
      process.stdout.write(text);
    });

    claude.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      output += text;
      process.stderr.write(text);
    });

    claude.on('close', async (code: number) => {
      fs.writeFileSync(sessionLogFile, output);
      log(`Responsibility ${resp.role}/${resp.name} completed with code ${code}`);

      if (code === 0) {
        markResponsibilityComplete(resp.role, resp.name);
        await sendTelegramAlert(`✅ *${resp.role}*\nCompleted: ${resp.name}`);
        resolve();
      } else {
        await sendTelegramAlert(`❌ *${resp.role}*\nFailed: ${resp.name}`);
        reject(new Error(`Responsibility failed with code ${code}`));
      }
    });

    claude.on('error', (error: Error) => {
      log(`Error spawning claude for responsibility: ${error.message}`);
      reject(error);
    });
  });
}

/**
 * Spawn an agent for a handoff
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
1. Read your agent definition at .claude/agents/${handoff.to}.md
2. Complete the handoff request
3. Update state files as needed
4. Return a clear result

The result of this handoff will be recorded for ${handoff.from} to see.
`;

  return new Promise((resolve, reject) => {
    const claude = spawn('claude', [
      '-p', prompt,
      '--output-format', 'text',
      '--dangerously-skip-permissions'
    ], {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    let output = '';

    claude.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      output += text;
      process.stdout.write(text);
    });

    claude.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      output += text;
      process.stderr.write(text);
    });

    claude.on('close', async (code: number) => {
      fs.writeFileSync(sessionLogFile, output);
      log(`Handoff ${handoff.id} completed with code ${code}`);

      if (code === 0) {
        completeHandoff(handoff.id, { success: true, output: output.slice(-500) });
        await sendTelegramAlert(`✅ *Handoff completed*\n${handoff.id}`);
        resolve();
      } else {
        completeHandoff(handoff.id, { success: false, error: `Exit code ${code}` });
        await sendTelegramAlert(`❌ *Handoff failed*\n${handoff.id}`);
        reject(new Error(`Handoff failed with code ${code}`));
      }
    });

    claude.on('error', (error: Error) => {
      log(`Error spawning claude for handoff: ${error.message}`);
      reject(error);
    });
  });
}

function updateEngineStatus(): void {
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

  // Handle autonomous wake tasks - spawn Claude with general autonomous prompt
  if (task.type === 'autonomous') {
    log(`Executing autonomous wake task: ${task.id}`);

    const autonomousPrompt = `You are waking up for autonomous operation.

## Your Mission
Read MISSION.md for your full operating instructions.

## Current Task
ID: ${task.id}
Description: ${task.description}

## Instructions
1. Read state/status.md, state/hypotheses.json, state/portfolio.json
2. Identify the highest-priority actionable task
3. Execute that task - advance a hypothesis, make a trade, fix something
4. Update state files with results
5. Log your session summary to state/logs/
6. Update state/status.md with current status

## Key Principle
Every session must produce OUTPUT - a trade, a hypothesis advanced, or infrastructure fixed.
Don't just observe - ACT.
`;

    return new Promise((resolve, reject) => {
      const claude = spawn('claude', [
        '-p', autonomousPrompt,
        '--output-format', 'text',
        '--dangerously-skip-permissions'
      ], {
        cwd: path.join(__dirname),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env }
      });

      let output = '';

      claude.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        output += text;
        process.stdout.write(text);
      });

      claude.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        output += text;
        process.stderr.write(text);
      });

      claude.on('close', async (code: number) => {
        fs.writeFileSync(sessionLogFile, output);
        log(`Autonomous task ${task.id} completed with code ${code}`);

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

        if (code === 0) {
          await sendTelegramAlert(`✅ *Autonomous wake completed*\n\`${task.id}\``);
          resolve();
        } else {
          await sendTelegramAlert(`❌ *Autonomous wake failed*\n\`${task.id}\`\nExit code: ${code}`);
          reject(new Error(`Claude exited with code ${code}`));
        }
      });

      claude.on('error', (error: Error) => {
        log(`Error spawning claude for autonomous task: ${error.message}`);
        reject(error);
      });
    });
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

  // For non-pipeline tasks, spawn Claude
  const prompt = buildPrompt(task);

  return new Promise((resolve, reject) => {
    const claude = spawn('claude', [
      '-p', prompt,
      '--output-format', 'text',
      '--dangerously-skip-permissions'
    ], {
      cwd: path.join(__dirname),
      stdio: ['ignore', 'pipe', 'pipe'],  // ignore stdin to prevent hanging
      env: { ...process.env }
    });

    let output = '';

    claude.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      output += text;
      process.stdout.write(text);
    });

    claude.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      output += text;
      process.stderr.write(text);
    });

    claude.on('close', async (code: number) => {
      fs.writeFileSync(sessionLogFile, output);
      log(`Task ${task.id} completed with code ${code}`);

      if (code === 0) {
        await sendTelegramAlert(`✅ *Task completed*\n\`${task.id}\``);
        resolve();
      } else {
        await sendTelegramAlert(`❌ *Task failed*\n\`${task.id}\`\nExit code: ${code}`);
        reject(new Error(`Claude exited with code ${code}`));
      }
    });

    claude.on('error', (error: Error) => {
      log(`Error spawning claude: ${error.message}`);
      reject(error);
    });
  });
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

function markTaskComplete(schedule: Schedule, taskId: string): void {
  const taskIndex = schedule.pendingTasks.findIndex(t => t.id === taskId);
  if (taskIndex !== -1) {
    const task = schedule.pendingTasks.splice(taskIndex, 1)[0];
    schedule.completedTasks.push({
      ...task,
      completedAt: new Date().toISOString()
    } as ScheduledTask & { completedAt: string });
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

    // Priority 1: Check for due responsibilities
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

    // Priority 2: Check for pending handoffs
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

    // Priority 3: Check for scheduled tasks (legacy support)
    const schedule = loadSchedule();

    // Ensure all recurring pipelines are scheduled
    if (ensurePipelinesScheduled(schedule)) {
      saveSchedule(schedule);
    }

    const task = getNextTask(schedule);

    if (task) {
      try {
        await executeTask(task);
        markTaskComplete(schedule, task.id);
        saveSchedule(schedule);
        await gitPush();
      } catch (error) {
        log(`Task ${task.id} failed: ${error}`);
        await gitPush();
      }
    }
  };

  // Initial tick
  await tick();

  // Continue checking
  setInterval(tick, checkInterval);

  log('Daemon running (5 min interval). Press Ctrl+C to stop.');
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
          markTaskComplete(sched, nextTask.id);
          saveSchedule(sched);
          await gitPush(); // Push changes after completion
          console.log('Task completed');
        })
        .catch(async (err) => {
          console.error(err);
          await gitPush(); // Still push any partial changes
        });
    } else {
      // Trigger first pending task regardless of schedule
      if (sched.pendingTasks.length > 0) {
        const task = sched.pendingTasks[0];
        executeTask(task)
          .then(async () => {
            markTaskComplete(sched, task.id);
            saveSchedule(sched);
            await gitPush(); // Push changes after completion
            console.log('Task completed');
          })
          .catch(async (err) => {
            console.error(err);
            await gitPush(); // Still push any partial changes
          });
      } else {
        console.log('No pending tasks');
      }
    }
    break;

  case 'query':
    // Interactive query mode - spawn claude with context
    const queryPrompt = process.argv.slice(3).join(' ') || 'What is your current status?';
    spawn('claude', [
      '-p', `You are the trader agent. Read state/status.md and answer this query: ${queryPrompt}`,
      '--permission-mode', 'bypassPermissions'
    ], {
      cwd: __dirname,
      stdio: 'inherit'
    });
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
