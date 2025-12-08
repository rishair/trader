import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { spawn } from 'child_process';
import { sendMessage, pollMessages } from './bot';

const STATE_DIR = path.join(__dirname, '../../state');
const INBOX_FILE = path.join(STATE_DIR, 'inbox.json');
const APPROVALS_FILE = path.join(STATE_DIR, 'pending_approvals.json');
const STATUS_FILE = path.join(STATE_DIR, 'status.md');
const PROJECT_ROOT = path.join(__dirname, '../..');
const LOG_DIR = path.join(STATE_DIR, 'logs');

// Track if a Claude session is currently running
let claudeSessionActive = false;

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
    const claude = spawn('claude', ['-p', prompt, '--output-format', 'text'], {
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
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
/help - This help

*Approvals:*
/approve <id> - Approve a strategy
/reject <id> [reason] - Reject a strategy
/approve all - Approve all pending

*Actions:*
/wake - Run next scheduled task
/process - Process inbox items
/claude <prompt> - Run custom prompt

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
    } catch (error) {
      console.error('Error handling message:', error);
      await sendMessage('❌ Error processing message. Check logs.', msg.chatId);
    }
  });
}

if (require.main === module) {
  startHandler();
}
