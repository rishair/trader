import { spawn, ChildProcess, execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const STATE_DIR = path.join(__dirname, 'state');
const CHAT_ID_FILE = path.join(STATE_DIR, 'telegram_chat_id.txt');

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

  const prompt = buildPrompt(task);
  const sessionLogFile = path.join(LOG_DIR, `session-${task.id}-${Date.now()}.log`);

  return new Promise((resolve, reject) => {
    const claude = spawn('claude', ['-p', prompt, '--output-format', 'text'], {
      cwd: path.join(__dirname),
      stdio: ['pipe', 'pipe', 'pipe'],
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
    spawn('claude', ['-p', `You are the trader agent. Read state/status.md and answer this query: ${queryPrompt}`], {
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
