import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { spawn } from 'child_process';
import { sendMessage, pollMessages } from './bot';

const STATE_DIR = path.join(__dirname, '../../state');
const INBOX_FILE = path.join(STATE_DIR, 'inbox.json');
const APPROVALS_FILE = path.join(STATE_DIR, 'pending_approvals.json');
const STATUS_FILE = path.join(STATE_DIR, 'status.md');
const ERRORS_FILE = path.join(STATE_DIR, 'errors.json');
const PROJECT_ROOT = path.join(__dirname, '../..');
const LOG_DIR = path.join(STATE_DIR, 'logs');

// Track if a Claude session is currently running
let claudeSessionActive = false;

// ============ Error Tracking & Self-Healing ============

interface TrackedError {
  id: string;
  timestamp: string;
  context: string;
  error: string;
  stack?: string;
  input?: string;
  resolved: boolean;
  resolution?: string;
  autoHealed?: boolean;
}

interface ErrorLog {
  errors: TrackedError[];
  stats: {
    total: number;
    resolved: number;
    autoHealed: number;
    lastError?: string;
  };
}

function loadErrors(): ErrorLog {
  try {
    return JSON.parse(fs.readFileSync(ERRORS_FILE, 'utf-8'));
  } catch {
    return { errors: [], stats: { total: 0, resolved: 0, autoHealed: 0 } };
  }
}

function saveErrors(log: ErrorLog): void {
  fs.writeFileSync(ERRORS_FILE, JSON.stringify(log, null, 2));
}

function trackError(context: string, error: Error | string, input?: string): string {
  const log = loadErrors();
  const id = `err-${Date.now()}`;
  const errorStr = error instanceof Error ? error.message : error;
  const stack = error instanceof Error ? error.stack : undefined;

  log.errors.push({
    id,
    timestamp: new Date().toISOString(),
    context,
    error: errorStr,
    stack,
    input,
    resolved: false,
  });

  log.stats.total++;
  log.stats.lastError = new Date().toISOString();

  // Keep only last 100 errors
  if (log.errors.length > 100) {
    log.errors = log.errors.slice(-100);
  }

  saveErrors(log);
  console.error(`[ERROR ${id}] ${context}: ${errorStr}`);
  return id;
}

function resolveError(id: string, resolution: string, autoHealed = false): void {
  const log = loadErrors();
  const err = log.errors.find(e => e.id === id);
  if (err) {
    err.resolved = true;
    err.resolution = resolution;
    err.autoHealed = autoHealed;
    log.stats.resolved++;
    if (autoHealed) log.stats.autoHealed++;
    saveErrors(log);
  }
}

// Known error patterns and their fixes
const SELF_HEAL_PATTERNS: Array<{
  pattern: RegExp;
  context: string;
  fix: () => Promise<string>;
}> = [
  {
    pattern: /ENOENT.*inbox\.json/i,
    context: 'Missing inbox file',
    fix: async () => {
      const defaultInbox: Inbox = { items: [], schema: {}, notes: '' };
      fs.writeFileSync(INBOX_FILE, JSON.stringify(defaultInbox, null, 2));
      return 'Created default inbox.json';
    },
  },
  {
    pattern: /ENOENT.*pending_approvals\.json/i,
    context: 'Missing approvals file',
    fix: async () => {
      const defaultApprovals: Approvals = { approvals: [], schema: {}, notes: '' };
      fs.writeFileSync(APPROVALS_FILE, JSON.stringify(defaultApprovals, null, 2));
      return 'Created default pending_approvals.json';
    },
  },
  {
    pattern: /ENOENT.*status\.md/i,
    context: 'Missing status file',
    fix: async () => {
      fs.writeFileSync(STATUS_FILE, '# Status\n\nNo status available yet.');
      return 'Created default status.md';
    },
  },
  {
    pattern: /SyntaxError.*JSON/i,
    context: 'Corrupted JSON file',
    fix: async () => {
      // This is trickier - we'd need to know which file
      return 'JSON parse error detected - manual intervention may be needed';
    },
  },
];

async function attemptSelfHeal(error: Error | string): Promise<{ healed: boolean; action: string }> {
  const errorStr = error instanceof Error ? error.message : error;

  for (const pattern of SELF_HEAL_PATTERNS) {
    if (pattern.pattern.test(errorStr)) {
      try {
        const result = await pattern.fix();
        return { healed: true, action: result };
      } catch (fixError) {
        return { healed: false, action: `Self-heal failed: ${fixError}` };
      }
    }
  }

  return { healed: false, action: 'No automatic fix available' };
}

// ============ Inbox Management ============

interface InboxItem {
  id: string;
  type: string;
  source: string;
  receivedAt: string;
  status: string;
  title: string;
  content: any;
  evaluation?: any;
  actions?: any[];
}

interface Inbox {
  items: InboxItem[];
  schema: any;
  notes: string;
}

function loadInbox(): Inbox {
  try {
    return JSON.parse(fs.readFileSync(INBOX_FILE, 'utf-8'));
  } catch {
    return { items: [], schema: {}, notes: '' };
  }
}

function saveInbox(inbox: Inbox): void {
  fs.writeFileSync(INBOX_FILE, JSON.stringify(inbox, null, 2));
}

function addToInbox(content: string, type: string, title: string): string {
  const inbox = loadInbox();
  const id = `inbox-${Date.now()}`;

  inbox.items.push({
    id,
    type,
    source: 'telegram',
    receivedAt: new Date().toISOString(),
    status: 'pending',
    title,
    content: { raw: content },
  });

  saveInbox(inbox);
  return id;
}

// ============ Approvals Management ============

interface Approval {
  id: string;
  type: string;
  title: string;
  description: string;
  proposedAt: string;
  status: string;
  context: any;
  decidedAt: string | null;
  decisionNote: string | null;
}

interface Approvals {
  approvals: Approval[];
  schema: any;
  notes: string;
}

function loadApprovals(): Approvals {
  try {
    return JSON.parse(fs.readFileSync(APPROVALS_FILE, 'utf-8'));
  } catch {
    return { approvals: [], schema: {}, notes: '' };
  }
}

function saveApprovals(approvals: Approvals): void {
  fs.writeFileSync(APPROVALS_FILE, JSON.stringify(approvals, null, 2));
}

function getPendingApprovals(): Approval[] {
  const approvals = loadApprovals();
  return approvals.approvals.filter(a => a.status === 'pending');
}

function approveItem(id: string, note?: string): boolean {
  const approvals = loadApprovals();
  const item = approvals.approvals.find(a => a.id === id);
  if (!item || item.status !== 'pending') return false;

  item.status = 'approved';
  item.decidedAt = new Date().toISOString();
  item.decisionNote = note || null;
  saveApprovals(approvals);
  return true;
}

function rejectItem(id: string, note?: string): boolean {
  const approvals = loadApprovals();
  const item = approvals.approvals.find(a => a.id === id);
  if (!item || item.status !== 'pending') return false;

  item.status = 'rejected';
  item.decidedAt = new Date().toISOString();
  item.decisionNote = note || null;
  saveApprovals(approvals);
  return true;
}

// ============ Git Sync ============

function gitPull(): void {
  try {
    execSync('git pull origin main', { cwd: PROJECT_ROOT, stdio: 'pipe' });
  } catch (e) {
    console.error('Git pull failed:', e);
  }
}

function gitPush(message: string): void {
  try {
    const status = execSync('git status --porcelain', { cwd: PROJECT_ROOT, encoding: 'utf-8' });
    if (status.trim()) {
      execSync('git add -A', { cwd: PROJECT_ROOT, stdio: 'pipe' });
      execSync(`git commit -m "${message}"`, { cwd: PROJECT_ROOT, stdio: 'pipe' });
      execSync('git push origin main', { cwd: PROJECT_ROOT, stdio: 'pipe' });
    }
  } catch (e) {
    console.error('Git push failed:', e);
  }
}

// ============ Status ============

function getStatus(): string {
  try {
    return fs.readFileSync(STATUS_FILE, 'utf-8');
  } catch {
    return 'Status file not found';
  }
}

// ============ Content Detection ============

function detectContentType(text: string): { type: string; title: string } {
  const lower = text.toLowerCase();

  // URLs
  if (text.match(/^https?:\/\//)) {
    if (text.includes('twitter.com') || text.includes('x.com')) {
      return { type: 'reference', title: 'Twitter link' };
    }
    if (text.includes('polymarket.com')) {
      return { type: 'reference', title: 'Polymarket link' };
    }
    return { type: 'reference', title: 'Link' };
  }

  // Ideas/hypotheses
  if (lower.includes('hypothesis') || lower.includes('strategy') || lower.includes('idea')) {
    return { type: 'hypothesis', title: 'Strategy idea' };
  }

  // News
  if (lower.includes('news') || lower.includes('announced') || lower.includes('breaking')) {
    return { type: 'news', title: 'News item' };
  }

  return { type: 'other', title: 'Content' };
}

// ============ Claude Sessions ============

async function spawnClaudeSession(prompt: string, chatId: string, sessionName: string): Promise<string> {
  if (claudeSessionActive) {
    await sendMessage('⚠️ A Claude session is already running. Please wait.', chatId);
    return '';
  }

  claudeSessionActive = true;
  await sendMessage(`🚀 Starting: ${sessionName}`, chatId);

  const sessionLogFile = path.join(LOG_DIR, `telegram-${sessionName}-${Date.now()}.log`);

  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  return new Promise((resolve) => {
    const claude = spawn('claude', [
      '-p', prompt,
      '--output-format', 'text'
    ], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],  // ignore stdin to prevent hanging
      env: { ...process.env }
    });

    let output = '';

    claude.stdout?.on('data', (data: Buffer) => {
      output += data.toString();
    });

    claude.stderr?.on('data', (data: Buffer) => {
      output += data.toString();
    });

    claude.on('close', async (code: number) => {
      claudeSessionActive = false;
      fs.writeFileSync(sessionLogFile, output);

      if (code === 0) {
        const summary = output.length > 1000
          ? '...' + output.slice(-1000)
          : output;
        await sendMessage(`✅ Done.\n\n${summary}`, chatId);
      } else {
        await sendMessage(`❌ Failed (code ${code}). Check logs.`, chatId);
      }
      resolve(output);
    });

    claude.on('error', async (error: Error) => {
      claudeSessionActive = false;
      await sendMessage(`❌ Error: ${error.message}`, chatId);
      resolve('');
    });
  });
}

// ============ Message Handler ============

async function handleMessage(text: string, chatId: string): Promise<void> {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // Always sync before handling
  gitPull();

  // ===== Commands =====

  if (lower === '/status' || lower === 'status') {
    const status = getStatus();
    const truncated = status.length > 4000 ? status.slice(0, 4000) + '\n...(truncated)' : status;
    await sendMessage(truncated, chatId);
    return;
  }

  if (lower === '/help' || lower === 'help') {
    await sendMessage(
`*Trader Bot Commands*

*Info:*
/status - Current status
/pending - Show pending approvals
/errors - Recent errors
/help - This help

*Approvals:*
/approve <id> - Approve a strategy
/reject <id> [reason] - Reject a strategy
/approve all - Approve all pending

*Actions:*
/wake - Run next scheduled task
/process - Process inbox items
/claude <prompt> - Run custom prompt
/heal - AI-analyze and fix errors

*Content:*
Just send me links, ideas, news - I'll add to inbox.`,
      chatId
    );
    return;
  }

  if (lower === '/pending') {
    const pending = getPendingApprovals();
    if (pending.length === 0) {
      await sendMessage('No pending approvals.', chatId);
      return;
    }

    let msg = `*Pending Approvals (${pending.length}):*\n\n`;
    for (const p of pending) {
      msg += `*${p.id}*\n`;
      msg += `Type: ${p.type}\n`;
      msg += `${p.title}\n`;
      msg += `${p.description.slice(0, 200)}${p.description.length > 200 ? '...' : ''}\n\n`;
    }
    msg += `Reply: /approve <id> or /reject <id> [reason]`;
    await sendMessage(msg, chatId);
    return;
  }

  if (lower.startsWith('/approve')) {
    const parts = trimmed.split(/\s+/);
    const target = parts[1];

    if (!target) {
      await sendMessage('Usage: /approve <id> or /approve all', chatId);
      return;
    }

    if (target.toLowerCase() === 'all') {
      const pending = getPendingApprovals();
      for (const p of pending) {
        approveItem(p.id, 'Batch approved');
      }
      gitPush('Batch approve all pending');
      await sendMessage(`✅ Approved ${pending.length} items.`, chatId);

      // Trigger processing of approved items
      await spawnClaudeSession(
        `You are the trader agent. Check state/pending_approvals.json for newly approved items and execute them. Read MISSION.md for context. Update state and log results.`,
        chatId,
        'execute-approved'
      );
      return;
    }

    if (approveItem(target)) {
      gitPush(`Approved: ${target}`);
      await sendMessage(`✅ Approved: ${target}`, chatId);

      // Trigger execution
      await spawnClaudeSession(
        `You are the trader agent. The item ${target} in state/pending_approvals.json was just approved. Execute it. Read MISSION.md for context.`,
        chatId,
        'execute-approved'
      );
    } else {
      await sendMessage(`❌ Not found or already decided: ${target}`, chatId);
    }
    return;
  }

  if (lower.startsWith('/reject')) {
    const parts = trimmed.split(/\s+/);
    const target = parts[1];
    const reason = parts.slice(2).join(' ') || undefined;

    if (!target) {
      await sendMessage('Usage: /reject <id> [reason]', chatId);
      return;
    }

    if (rejectItem(target, reason)) {
      gitPush(`Rejected: ${target}`);
      await sendMessage(`❌ Rejected: ${target}${reason ? ` (${reason})` : ''}`, chatId);
    } else {
      await sendMessage(`Not found or already decided: ${target}`, chatId);
    }
    return;
  }

  if (lower === '/wake') {
    await spawnClaudeSession(
      `You are waking up to execute scheduled tasks. Read MISSION.md first. Check state/schedule.json for pending tasks. Execute the highest priority due task. Update state files. Log session.`,
      chatId,
      'wake'
    );
    gitPush('Wake task executed');
    return;
  }

  if (lower === '/process') {
    // Get pending count before processing
    const beforeCount = getPendingApprovals().length;

    await spawnClaudeSession(
      `You are the trader agent. Process pending items in state/inbox.json. For each:
1. Evaluate relevance, actionability, urgency
2. Route to appropriate state file (hypotheses.json, resources.json, etc)
3. If it suggests a strategy/trade, create an entry in state/pending_approvals.json for user approval
4. Mark inbox items as processed
Read MISSION.md for context.`,
      chatId,
      'process-inbox'
    );
    gitPush('Inbox processed');

    // Check for new pending approvals and notify
    gitPull(); // Get latest state after Claude session
    const afterPending = getPendingApprovals();
    const newCount = afterPending.length - beforeCount;

    if (newCount > 0) {
      let msg = `\n📋 *${newCount} new proposal(s) awaiting approval:*\n\n`;
      // Show the newest ones (at the end of the array)
      const newApprovals = afterPending.slice(-newCount);
      for (const p of newApprovals) {
        msg += `*${p.id}*\n`;
        msg += `${p.title}\n`;
        msg += `${p.description.slice(0, 150)}${p.description.length > 150 ? '...' : ''}\n\n`;
      }
      msg += `Reply: /approve <id> or /reject <id>`;
      await sendMessage(msg, chatId);
    }
    return;
  }

  if (lower.startsWith('/claude')) {
    const userPrompt = trimmed.slice(7).trim();
    if (!userPrompt) {
      await sendMessage('Usage: /claude <your prompt>', chatId);
      return;
    }

    await spawnClaudeSession(
      `You are the trader agent. Read MISSION.md for context.\n\nUser request: ${userPrompt}\n\nExecute and summarize.`,
      chatId,
      'custom'
    );
    gitPush('Custom Claude session');
    return;
  }

  if (lower === '/ping' || lower === 'ping') {
    await sendMessage('pong 🏓', chatId);
    return;
  }

  if (lower === '/errors') {
    const log = loadErrors();
    const recent = log.errors.slice(-5).reverse();

    if (recent.length === 0) {
      await sendMessage('✅ No errors recorded.', chatId);
      return;
    }

    let msg = `*Recent Errors (${log.stats.total} total, ${log.stats.autoHealed} auto-healed):*\n\n`;
    for (const err of recent) {
      const status = err.resolved ? (err.autoHealed ? '⚡' : '✅') : '❌';
      msg += `${status} \`${err.id}\`\n`;
      msg += `${err.context}: ${err.error.slice(0, 100)}\n`;
      msg += `${err.timestamp}\n`;
      if (err.resolution) msg += `Fix: ${err.resolution}\n`;
      msg += '\n';
    }
    await sendMessage(msg, chatId);
    return;
  }

  if (lower === '/heal') {
    // Trigger Claude to analyze and fix errors
    const log = loadErrors();
    const unresolved = log.errors.filter(e => !e.resolved).slice(-5);

    if (unresolved.length === 0) {
      await sendMessage('✅ No unresolved errors to heal.', chatId);
      return;
    }

    const errorSummary = unresolved.map(e => `- ${e.context}: ${e.error}`).join('\n');

    await spawnClaudeSession(
      `You are the trader agent. Analyze these recent errors and fix them if possible:

${errorSummary}

Check the relevant files, understand what went wrong, and apply fixes. Update state/errors.json to mark resolved errors. Be concise.`,
      chatId,
      'heal-errors'
    );
    return;
  }

  // ===== Content (not a command) =====

  const { type, title } = detectContentType(trimmed);
  const id = addToInbox(trimmed, type, title);
  gitPush(`Inbox: ${title}`);

  await sendMessage(`📥 Added to inbox (${type})\nID: ${id}\n\nI'll process it on next /process or wake.`, chatId);
}

// ============ Main ============

export async function startHandler(): Promise<void> {
  console.log('Telegram handler starting...');
  console.log('Syncing with git...');
  gitPull();

  await pollMessages(async (msg) => {
    console.log(`[${new Date().toISOString()}] ${msg.from}: ${msg.text}`);
    try {
      await handleMessage(msg.text, msg.chatId);
    } catch (error: any) {
      // Track the error
      const errorId = trackError('handleMessage', error, msg.text);

      // Attempt self-healing
      const healResult = await attemptSelfHeal(error);

      if (healResult.healed) {
        resolveError(errorId, healResult.action, true);
        await sendMessage(`⚡ Auto-healed: ${healResult.action}\nRetrying...`, msg.chatId);

        // Retry the message
        try {
          await handleMessage(msg.text, msg.chatId);
          return;
        } catch (retryError: any) {
          trackError('handleMessage-retry', retryError, msg.text);
        }
      }

      // Send detailed error to user
      const errorMsg = error instanceof Error ? error.message : String(error);
      await sendMessage(
        `❌ Error: ${errorMsg.slice(0, 200)}\n\nID: ${errorId}\nUse /errors to see recent errors.`,
        msg.chatId
      );
    }
  });
}

if (require.main === module) {
  startHandler();
}
