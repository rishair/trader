import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import { spawn } from 'child_process';
import { sendMessage, editMessage, pollMessages, escapeMarkdown, sendCommitNotification } from './bot';

const STATE_DIR = path.join(__dirname, '../../state');
const INBOX_FILE = path.join(STATE_DIR, 'inbox.json');
const APPROVALS_FILE = path.join(STATE_DIR, 'pending_approvals.json');
const STATUS_FILE = path.join(STATE_DIR, 'status.md');
const ERRORS_FILE = path.join(STATE_DIR, 'errors.json');
const PROJECT_ROOT = path.join(__dirname, '../..');
const LOG_DIR = path.join(STATE_DIR, 'logs');
const SESSION_FILE = path.join(STATE_DIR, 'telegram_session.json');

// Track if a Claude session is currently running
let claudeSessionActive = false;

// ============ Persistent Session Management ============

interface SessionState {
  sessionId: string;
  createdAt: string;
  lastMessageAt: string;
  messageCount: number;
  // Track if this session has been successfully started with Claude
  claudeSessionStarted: boolean;
}

function loadSession(): SessionState | null {
  try {
    const session = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    // Handle legacy sessions without claudeSessionStarted field
    if (session.claudeSessionStarted === undefined) {
      session.claudeSessionStarted = false;
    }
    return session;
  } catch {
    return null;
  }
}

function saveSession(session: SessionState): void {
  fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
}

function createNewSession(): SessionState {
  const session: SessionState = {
    sessionId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    lastMessageAt: new Date().toISOString(),
    messageCount: 0,
    claudeSessionStarted: false,
  };
  saveSession(session);
  return session;
}

function getOrCreateSession(): SessionState {
  let session = loadSession();
  if (!session) {
    session = createNewSession();
  }
  return session;
}

function updateSessionActivity(): void {
  const session = loadSession();
  if (session) {
    session.lastMessageAt = new Date().toISOString();
    session.messageCount++;
    saveSession(session);
  }
}

function markSessionStarted(): void {
  const session = loadSession();
  if (session) {
    session.claudeSessionStarted = true;
    saveSession(session);
  }
}

// Check if a Claude session actually exists
function claudeSessionExists(sessionId: string): boolean {
  try {
    // Use claude --list-sessions or check if we can resume
    // Since there's no direct API, we track this ourselves
    const session = loadSession();
    return session?.claudeSessionStarted === true && session.sessionId === sessionId;
  } catch {
    return false;
  }
}

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

async function gitPush(message: string): Promise<void> {
  try {
    const status = execSync('git status --porcelain', { cwd: PROJECT_ROOT, encoding: 'utf-8' });
    if (status.trim()) {
      execSync('git add -A', { cwd: PROJECT_ROOT, stdio: 'pipe' });
      execSync(`git commit -m "${message}"`, { cwd: PROJECT_ROOT, stdio: 'pipe' });

      // Get the commit hash for notification
      const commitHash = execSync('git rev-parse --short HEAD', { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim();

      execSync('git push origin main', { cwd: PROJECT_ROOT, stdio: 'pipe' });

      // Notify with GitHub link
      await sendCommitNotification(commitHash, message);
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

const MAX_MSG_LEN = 4000; // Telegram limit is 4096, leave room for formatting
const STREAM_UPDATE_INTERVAL = 1500; // Update message every 1.5 seconds

interface ClaudeSessionOptions {
  prompt: string;
  chatId: string;
  sessionName: string;
  // If true, use persistent session with --resume
  persistent?: boolean;
  // Custom session ID (for persistent sessions)
  sessionId?: string;
  // If true, this is the first message in the session (use --session-id to create)
  // If false, this is a follow-up (use --resume to continue)
  isFirstMessage?: boolean;
}

async function spawnClaudeSession(prompt: string, chatId: string, sessionName: string): Promise<string>;
async function spawnClaudeSession(options: ClaudeSessionOptions): Promise<string>;
async function spawnClaudeSession(
  promptOrOptions: string | ClaudeSessionOptions,
  chatId?: string,
  sessionName?: string
): Promise<string> {
  // Handle overloaded signatures
  let options: ClaudeSessionOptions;
  if (typeof promptOrOptions === 'string') {
    options = {
      prompt: promptOrOptions,
      chatId: chatId!,
      sessionName: sessionName!,
      persistent: false,
    };
  } else {
    options = promptOrOptions;
  }

  if (claudeSessionActive) {
    await sendMessage('⚠️ A Claude session is already running. Please wait.', options.chatId);
    return '';
  }

  claudeSessionActive = true;

  // Send initial message and capture message_id for streaming updates
  const messageId = await sendMessage(`🚀 *${escapeMarkdown(options.sessionName)}*\n\n_Starting\\.\\.\\._`, options.chatId);

  const sessionLogFile = path.join(LOG_DIR, `telegram-${options.sessionName}-${Date.now()}.log`);

  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  // Build Claude CLI arguments
  const claudeArgs: string[] = [
    '-p', options.prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions'
  ];

  // For persistent sessions:
  // - First message: use --session-id to create a new session with that ID
  // - Follow-up messages: use --resume to continue the existing conversation
  if (options.persistent && options.sessionId) {
    if (options.isFirstMessage) {
      claudeArgs.push('--session-id', options.sessionId);
    } else {
      claudeArgs.push('--resume', options.sessionId);
    }
  }

  return new Promise((resolve) => {
    const claude = spawn('claude', claudeArgs, {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    let output = '';
    let lastUpdateTime = 0;
    let updatePending = false;
    let toolsUsed: string[] = [];

    // Function to update the Telegram message with current output
    const updateMessage = async (final = false) => {
      if (!messageId) return;

      const now = Date.now();
      if (!final && now - lastUpdateTime < STREAM_UPDATE_INTERVAL) {
        // Schedule an update if one isn't pending
        if (!updatePending) {
          updatePending = true;
          setTimeout(() => {
            updatePending = false;
            updateMessage();
          }, STREAM_UPDATE_INTERVAL);
        }
        return;
      }

      lastUpdateTime = now;

      const status = final ? '✅' : '⏳';
      const trimmedOutput = output.trim();

      // Truncate for display (show last part if too long)
      let displayOutput = trimmedOutput;
      if (displayOutput.length > MAX_MSG_LEN - 200) {
        displayOutput = '...' + displayOutput.slice(-(MAX_MSG_LEN - 200));
      }

      // Show tools being used
      const toolsInfo = toolsUsed.length > 0 ? `\n🔧 _${toolsUsed.slice(-3).join(' → ')}_\n` : '';

      const header = final ? `${status} *${escapeMarkdown(options.sessionName)}* \\- Done` : `${status} *${escapeMarkdown(options.sessionName)}* \\- Running\\.\\.\\.`;
      const safeOutput = escapeMarkdown(displayOutput || 'waiting for output...');
      const safeToolsInfo = toolsUsed.length > 0 ? `\n🔧 _${escapeMarkdown(toolsUsed.slice(-3).join(' → '))}_\n` : '';
      await editMessage(messageId, `${header}${safeToolsInfo}\n${safeOutput}`, options.chatId);
    };

    claude.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(l => l.trim());

      for (const line of lines) {
        try {
          const event = JSON.parse(line);

          // Extract text content from assistant messages
          if (event.type === 'assistant' && event.message?.content) {
            for (const block of event.message.content) {
              if (block.type === 'text' && block.text) {
                output = block.text;
                updateMessage();
              } else if (block.type === 'tool_use') {
                toolsUsed.push(block.name);
                updateMessage();
              }
            }
          }

          // Handle content block deltas for streaming text
          if (event.type === 'content_block_delta' && event.delta?.text) {
            output += event.delta.text;
            updateMessage();
          }

          // Handle result messages - this is the final output
          if (event.type === 'result' && event.result) {
            output = event.result;
            updateMessage();
          }
        } catch {
          // Not JSON, might be plain text output
          if (line && !line.startsWith('{')) {
            output += line + '\n';
            updateMessage();
          }
        }
      }
    });

    claude.stderr?.on('data', (data: Buffer) => {
      // stderr might have progress info
      const text = data.toString();
      if (!text.includes('dotenv')) { // filter out dotenv noise
        output += text;
        updateMessage();
      }
    });

    claude.on('close', async (code: number) => {
      claudeSessionActive = false;
      fs.writeFileSync(sessionLogFile, output);

      if (code === 0) {
        // Mark persistent session as successfully started
        if (options.persistent && options.sessionId) {
          markSessionStarted();
        }

        // Final update to the streaming message
        await updateMessage(true);

        // If output is longer than what we showed, send additional messages with full content
        const fullMessage = output.trim();
        if (fullMessage.length > MAX_MSG_LEN - 100) {
          // Split into chunks and send as new messages
          const escapedFull = escapeMarkdown(fullMessage);
          const chunks: string[] = [];
          let remaining = escapedFull;
          while (remaining.length > 0) {
            chunks.push(remaining.slice(0, MAX_MSG_LEN));
            remaining = remaining.slice(MAX_MSG_LEN);
          }

          // Send full output as separate messages
          await sendMessage(`📄 *Full output \\(${chunks.length} parts\\):*`, options.chatId);
          for (let i = 0; i < chunks.length; i++) {
            await sendMessage(`\\(${i + 1}/${chunks.length}\\)\n${chunks[i]}`, options.chatId);
          }
        }
      } else {
        // Check if this was a failed resume attempt (session not found)
        const isSessionNotFound = output.includes('No conversation found with session ID') ||
                                   output.includes('session ID') && output.includes('not found');

        if (isSessionNotFound && options.persistent && options.sessionId && !options.isFirstMessage) {
          // Reset session and retry with --session-id instead of --resume
          await editMessage(messageId!, `🔄 *${escapeMarkdown(options.sessionName)}* \\- Session expired, restarting\\.\\.\\.`, options.chatId);

          // Reset the session state to force creation of new session
          const session = loadSession();
          if (session) {
            session.claudeSessionStarted = false;
            saveSession(session);
          }

          // The next message will use --session-id to create a new session
          resolve('SESSION_EXPIRED');
          return;
        }

        // Check if session ID is already in use (collision or stale state)
        const isSessionAlreadyInUse = output.includes('already in use');

        if (isSessionAlreadyInUse && options.persistent && options.sessionId) {
          // Generate a completely new session ID and retry
          await editMessage(messageId!, `🔄 *${escapeMarkdown(options.sessionName)}* \\- Session conflict, creating fresh session\\.\\.\\.`, options.chatId);

          // Create a brand new session with a fresh UUID
          const newSession = createNewSession();

          // Return special marker to trigger retry with new session
          resolve('SESSION_CONFLICT');
          return;
        }

        await editMessage(messageId!, `❌ *${escapeMarkdown(options.sessionName)}* \\- Failed \\(code ${code}\\)\n\n${escapeMarkdown(output.slice(-500) || 'No output')}`, options.chatId);
      }
      resolve(output);
    });

    claude.on('error', async (error: Error) => {
      claudeSessionActive = false;
      if (messageId) {
        await editMessage(messageId, `❌ *${escapeMarkdown(options.sessionName)}* \\- Error: ${escapeMarkdown(error.message)}`, options.chatId);
      }
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

*Chat:*
Just message me - I'll respond in our ongoing conversation.
/new - Start a fresh conversation
/session - Show current session info

*Info:*
/status - Current status
/pending - Show pending approvals
/errors - Recent errors
/ps - Running processes
/version [n] - Show version and last n commits
/help - This help

*Approvals:*
/approve <id> - Approve a strategy
/reject <id> [reason] - Reject a strategy
/approve all - Approve all pending
/execute <id> - Re-run an approved item

*Actions:*
/wake - Run next scheduled task
/process - Process inbox items
/inbox <content> - Add content to inbox
/heal - AI-analyze and fix errors
/start - Start the daemon
/stop - Stop the daemon
/deploy - Restart services with latest code
/rollback <hash> - Rollback to commit and redeploy`,
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
      await gitPush('Batch approve all pending');
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
      await gitPush(`Approved: ${target}`);
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

  if (lower.startsWith('/execute')) {
    const parts = trimmed.split(/\s+/);
    const target = parts[1];

    if (!target) {
      await sendMessage('Usage: /execute <id>', chatId);
      return;
    }

    // Find the approved item
    const approvals = loadApprovals();
    const item = approvals.approvals.find(a => a.id === target);

    if (!item) {
      await sendMessage(`❌ Not found: ${target}`, chatId);
      return;
    }

    if (item.status !== 'approved') {
      await sendMessage(`❌ Item ${target} is ${item.status}, not approved.`, chatId);
      return;
    }

    await spawnClaudeSession(
      `You are the trader agent. Execute this approved item from state/pending_approvals.json:

ID: ${item.id}
Type: ${item.type}
Title: ${item.title}
Description: ${item.description}
Context: ${JSON.stringify(item.context, null, 2)}

Read MISSION.md for context. Execute the task, update state files, and report results.`,
      chatId,
      'execute-approved'
    );
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
      await gitPush(`Rejected: ${target}`);
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
    await gitPush('Wake task executed');
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
    await gitPush('Inbox processed');

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

  // /new - Start a fresh conversation
  if (lower === '/new') {
    const session = createNewSession();
    await sendMessage(
      `🆕 Started new conversation.\nSession: \`${session.sessionId.slice(0, 8)}...\``,
      chatId
    );
    return;
  }

  // /session - Show current session info
  if (lower === '/session') {
    const session = loadSession();
    if (!session) {
      await sendMessage('No active session. Send a message to start one.', chatId);
      return;
    }
    const age = Math.round((Date.now() - new Date(session.createdAt).getTime()) / 1000 / 60);
    const claudeStatus = session.claudeSessionStarted ? '✅ Active' : '⏳ Not started';
    await sendMessage(
      `*Session Info*\n\nID: \`${session.sessionId.slice(0, 8)}...\`\nCreated: ${age} min ago\nMessages: ${session.messageCount}\nClaude: ${claudeStatus}`,
      chatId
    );
    return;
  }

  // /inbox - Add content to inbox (explicit)
  if (lower.startsWith('/inbox')) {
    const content = trimmed.slice(6).trim();
    if (!content) {
      await sendMessage('Usage: /inbox <content to add>', chatId);
      return;
    }
    const { type, title } = detectContentType(content);
    const id = addToInbox(content, type, title);
    await gitPush(`Inbox: ${title}`);
    await sendMessage(`📥 Added to inbox (${type})\nID: ${id}`, chatId);
    return;
  }

  if (lower === '/ping' || lower === 'ping') {
    await sendMessage('pong 🏓', chatId);
    return;
  }

  if (lower === '/start') {
    try {
      execSync('systemctl start trader-daemon', { encoding: 'utf-8' });
      const status = execSync('systemctl is-active trader-daemon', { encoding: 'utf-8' }).trim();
      await sendMessage(`✅ Daemon started (${status})`, chatId);
    } catch (e: any) {
      await sendMessage(`❌ Failed to start daemon: ${e.message}`, chatId);
    }
    return;
  }

  if (lower === '/stop') {
    try {
      execSync('systemctl stop trader-daemon', { encoding: 'utf-8' });
      await sendMessage(`✅ Daemon stopped`, chatId);
    } catch (e: any) {
      await sendMessage(`❌ Failed to stop daemon: ${e.message}`, chatId);
    }
    return;
  }

  if (lower === '/ps') {
    // Check running processes
    try {
      const psOutput = execSync('ps aux | grep claude | grep -v grep || echo "No claude processes"', { encoding: 'utf-8' });
      const nodeOutput = execSync('ps aux | grep "ts-node.*handler" | grep -v grep | wc -l', { encoding: 'utf-8' });

      const claudeCount = psOutput.includes('No claude') ? 0 : psOutput.trim().split('\n').length;
      const handlerCount = parseInt(nodeOutput.trim()) || 0;

      let daemonStatus = 'unknown';
      try {
        daemonStatus = execSync('systemctl is-active trader-daemon', { encoding: 'utf-8' }).trim();
      } catch {
        daemonStatus = 'inactive';
      }

      let msg = `*Process Status*\n\n`;
      msg += `🤖 Claude sessions: ${claudeCount}\n`;
      msg += `📡 Handler instances: ${handlerCount}\n`;
      msg += `⏳ Session active: ${claudeSessionActive ? 'Yes' : 'No'}\n`;
      msg += `👹 Daemon: ${daemonStatus}\n`;

      if (claudeCount > 0) {
        msg += `\n\`\`\`\n${psOutput.slice(0, 500)}\n\`\`\``;
      }

      await sendMessage(msg, chatId);
    } catch (e) {
      await sendMessage(`Error checking processes: ${e}`, chatId);
    }
    return;
  }

  // /version - Show current version and recent commits
  if (lower.startsWith('/version')) {
    const parts = trimmed.split(/\s+/);
    const count = parseInt(parts[1]) || 3;
    const limitedCount = Math.min(count, 20); // Cap at 20

    try {
      const currentHash = execSync('git rev-parse --short HEAD', { cwd: PROJECT_ROOT, encoding: 'utf-8' }).trim();
      const log = execSync(
        `git log --pretty=format:"%h %s" -${limitedCount}`,
        { cwd: PROJECT_ROOT, encoding: 'utf-8' }
      );

      // Get daemon version from engine-status.json
      let daemonInfo = '';
      try {
        const engineStatus = JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'trading/engine-status.json'), 'utf-8'));
        if (engineStatus.daemon) {
          const daemonAge = Math.round((Date.now() - new Date(engineStatus.daemon.startedAt).getTime()) / 1000 / 60);
          daemonInfo = `\n*Daemon:* \`${engineStatus.daemon.version}\` (up ${daemonAge}m)`;
          if (engineStatus.daemon.version !== currentHash) {
            daemonInfo += ` ⚠️ restart needed`;
          }
        }
      } catch {
        daemonInfo = '\n*Daemon:* unknown';
      }

      await sendMessage(`*Telegram:* \`${currentHash}\`${daemonInfo}\n\n*Last ${limitedCount} commits:*\n\`\`\`\n${log}\`\`\`\n\nUse \`/rollback <hash>\` to revert.`, chatId);
    } catch (e: any) {
      await sendMessage(`❌ Git error: ${e.message}`, chatId);
    }
    return;
  }

  // /deploy - Restart services to pick up new code
  if (lower === '/deploy') {
    await sendMessage('🔄 Deploying... handler will restart in 3s', chatId);

    // Give time for message to send, then kill processes
    // Systemd will auto-restart them with new code
    setTimeout(() => {
      try {
        execSync('pkill -f "daemon.ts"', { encoding: 'utf-8' });
      } catch {
        // Daemon might not be running
      }
      // Kill handler last (this will kill us)
      try {
        execSync('pkill -f "handler.ts"', { encoding: 'utf-8' });
      } catch {
        // Expected to fail since we're killing ourselves
      }
    }, 3000);
    return;
  }

  // /rollback - Rollback to a specific commit and redeploy
  if (lower.startsWith('/rollback')) {
    const parts = trimmed.split(/\s+/);
    const hash = parts[1];

    if (!hash) {
      await sendMessage('Usage: /rollback <commit-hash>\n\nUse /version to see recent commits.', chatId);
      return;
    }

    // Validate the hash exists
    try {
      execSync(`git cat-file -t ${hash}`, { cwd: PROJECT_ROOT, encoding: 'utf-8' });
    } catch {
      await sendMessage(`❌ Invalid commit hash: ${hash}`, chatId);
      return;
    }

    await sendMessage(`⚠️ Rolling back to \`${hash}\`...`, chatId);

    try {
      // Reset to the commit
      execSync(`git reset --hard ${hash}`, { cwd: PROJECT_ROOT, encoding: 'utf-8' });

      // Force push (we're on the server, need to update origin)
      execSync('git push origin main --force', { cwd: PROJECT_ROOT, encoding: 'utf-8' });

      await sendMessage('🔄 Restarting services in 3s...', chatId);

      // Give time for message to send, then kill processes
      setTimeout(() => {
        try {
          execSync('pkill -f "daemon.ts"', { encoding: 'utf-8' });
        } catch {
          // Daemon might not be running
        }
        try {
          execSync('pkill -f "handler.ts"', { encoding: 'utf-8' });
        } catch {
          // Expected
        }
      }, 3000);
    } catch (e: any) {
      await sendMessage(`❌ Rollback failed: ${e.message}`, chatId);
    }
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

  // ===== Default: Send to persistent Claude conversation =====

  const session = getOrCreateSession();
  updateSessionActivity();

  // Check if Claude session was successfully started before
  // Use claudeSessionStarted flag, not messageCount, because:
  // - The Claude CLI session may have expired or been cleared
  // - We need to track actual Claude state, not just our message count
  const isFirstMessage = !session.claudeSessionStarted;
  const prompt = isFirstMessage
    ? `You are the trader agent. Read MISSION.md for context.\n\nUser message: ${trimmed}`
    : trimmed;

  const result = await spawnClaudeSession({
    prompt,
    chatId,
    sessionName: 'chat',
    persistent: true,
    sessionId: session.sessionId,
    isFirstMessage,
  });

  // If session expired, retry with a fresh start
  if (result === 'SESSION_EXPIRED') {
    const newPrompt = `You are the trader agent. Read MISSION.md for context.\n\nUser message: ${trimmed}`;
    await spawnClaudeSession({
      prompt: newPrompt,
      chatId,
      sessionName: 'chat',
      persistent: true,
      sessionId: session.sessionId,
      isFirstMessage: true,
    });
  }

  // If session ID was already in use (conflict), retry with the new session that was created
  if (result === 'SESSION_CONFLICT') {
    const newSession = getOrCreateSession(); // This will load the freshly created session
    const newPrompt = `You are the trader agent. Read MISSION.md for context.\n\nUser message: ${trimmed}`;
    await sendMessage(`🆕 Created new session: \`${newSession.sessionId.slice(0, 8)}...\``, chatId);
    await spawnClaudeSession({
      prompt: newPrompt,
      chatId,
      sessionName: 'chat',
      persistent: true,
      sessionId: newSession.sessionId,
      isFirstMessage: true,
    });
  }
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
