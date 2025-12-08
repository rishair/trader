import { spawn, ChildProcess, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const STATE_DIR = path.join(__dirname, 'state');
const CHAT_ID_FILE = path.join(STATE_DIR, 'telegram_chat_id.txt');
const ENGINE_STATUS_FILE = path.join(STATE_DIR, 'engine-status.json');
const HYPOTHESES_FILE = path.join(STATE_DIR, 'hypotheses.json');

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
const SCHEDULE_FILE = path.join(STATE_DIR, 'schedule.json');
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

function gitPush(): boolean {
  try {
    log('Checking for changes to push...');
    const status = execSync('git status --porcelain', { cwd: __dirname, encoding: 'utf-8' });

    if (status.trim()) {
      log('Changes detected, committing and pushing...');
      execSync('git add -A', { cwd: __dirname, stdio: 'pipe' });
      execSync('git commit -m "Auto-commit: daemon task execution"', { cwd: __dirname, stdio: 'pipe' });
      execSync('git push origin main', { cwd: __dirname, stdio: 'pipe' });
      log('Git push successful');
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
};

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
  log('Daemon starting...');
  await sendTelegramAlert('🤖 *Trader daemon started*\nMonitoring for scheduled tasks...');

  // Ensure log directory exists
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  const checkInterval = 60 * 1000; // Check every minute

  const tick = async () => {
    // Pull latest state before checking for tasks
    gitPull();

    // Update engine status on every tick
    updateEngineStatus();

    const schedule = loadSchedule();
    const task = getNextTask(schedule);

    if (task) {
      try {
        await executeTask(task);
        markTaskComplete(schedule, task.id);
        saveSchedule(schedule);

        // Push state changes after task completion
        gitPush();
      } catch (error) {
        log(`Task ${task.id} failed: ${error}`);
        // Still try to push any partial state changes
        gitPush();
        // Don't mark as complete, will retry next tick
      }
    }
  };

  // Initial tick
  await tick();

  // Continue checking
  setInterval(tick, checkInterval);

  log('Daemon running. Press Ctrl+C to stop.');
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
        .then(() => {
          markTaskComplete(sched, nextTask.id);
          saveSchedule(sched);
          gitPush(); // Push changes after completion
          console.log('Task completed');
        })
        .catch((err) => {
          console.error(err);
          gitPush(); // Still push any partial changes
        });
    } else {
      // Trigger first pending task regardless of schedule
      if (sched.pendingTasks.length > 0) {
        const task = sched.pendingTasks[0];
        executeTask(task)
          .then(() => {
            markTaskComplete(sched, task.id);
            saveSchedule(sched);
            gitPush(); // Push changes after completion
            console.log('Task completed');
          })
          .catch((err) => {
            console.error(err);
            gitPush(); // Still push any partial changes
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
