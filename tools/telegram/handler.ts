import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { sendMessage, pollMessages } from './bot';

const STATE_DIR = path.join(__dirname, '../../state');
const INBOX_FILE = path.join(STATE_DIR, 'inbox.json');
const STATUS_FILE = path.join(STATE_DIR, 'status.md');
const PROJECT_ROOT = path.join(__dirname, '../..');
const LOG_DIR = path.join(STATE_DIR, 'logs');

// Track if a Claude session is currently running
let claudeSessionActive = false;

interface InboxItem {
  id: string;
  timestamp: string;
  source: 'telegram' | 'manual';
  content: string;
  type: 'link' | 'idea' | 'command' | 'feedback';
  processed: boolean;
  notes?: string;
}

function loadInbox(): InboxItem[] {
  try {
    return JSON.parse(fs.readFileSync(INBOX_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveInbox(inbox: InboxItem[]): void {
  fs.writeFileSync(INBOX_FILE, JSON.stringify(inbox, null, 2));
}

function addToInbox(content: string, type: InboxItem['type']): void {
  const inbox = loadInbox();
  inbox.push({
    id: `inbox_${Date.now()}`,
    timestamp: new Date().toISOString(),
    source: 'telegram',
    content,
    type,
    processed: false,
  });
  saveInbox(inbox);
}

function getStatus(): string {
  try {
    return fs.readFileSync(STATUS_FILE, 'utf-8');
  } catch {
    return 'Status file not found';
  }
}

function detectContentType(text: string): InboxItem['type'] {
  if (text.match(/^https?:\/\//)) return 'link';
  if (text.startsWith('/')) return 'command';
  return 'idea';
}

async function spawnClaudeSession(prompt: string, chatId: string, sessionName: string): Promise<void> {
  if (claudeSessionActive) {
    await sendMessage('⚠️ A Claude session is already running. Please wait for it to complete.', chatId);
    return;
  }

  claudeSessionActive = true;
  await sendMessage(`🚀 Starting Claude session: ${sessionName}`, chatId);

  const sessionLogFile = path.join(LOG_DIR, `telegram-${sessionName}-${Date.now()}.log`);

  // Ensure log directory exists
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
        // Send a summary (last 500 chars if output is long)
        const summary = output.length > 500
          ? '...' + output.slice(-500)
          : output;
        await sendMessage(`✅ Session complete.\n\n\`\`\`\n${summary}\n\`\`\``, chatId);
      } else {
        await sendMessage(`❌ Session failed with code ${code}. Check logs.`, chatId);
      }
      resolve();
    });

    claude.on('error', async (error: Error) => {
      claudeSessionActive = false;
      await sendMessage(`❌ Failed to start Claude: ${error.message}`, chatId);
      resolve();
    });
  });
}

async function handleMessage(text: string, chatId: string): Promise<void> {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();

  // Handle commands
  if (lower === '/status' || lower === 'status') {
    const status = getStatus();
    // Truncate if too long for Telegram (4096 char limit)
    const truncated = status.length > 4000 ? status.slice(0, 4000) + '\n...(truncated)' : status;
    await sendMessage(truncated, chatId);
    return;
  }

  if (lower === '/help' || lower === 'help') {
    await sendMessage(
      `*Trader Bot Commands*

/status - Get current status
/wake - Execute next scheduled task
/claude <prompt> - Run Claude with a custom prompt
/help - Show this help

*Send me:*
- Links to research
- Ideas or hypotheses
- Feedback on trades

I'll add them to my inbox and process them.`,
      chatId
    );
    return;
  }

  // /wake - trigger next scheduled task
  if (lower === '/wake') {
    const wakePrompt = `You are waking up to execute scheduled tasks.

## Your Mission
Read MISSION.md for your full operating instructions.

## Instructions
1. Check state/schedule.json for pending tasks
2. Execute the highest priority due task
3. Update state files with any changes
4. Log your session summary
5. Update state/status.md with current status
6. Schedule any follow-up tasks

Remember: You are autonomous. Make decisions, take actions, create tools if needed.`;

    await spawnClaudeSession(wakePrompt, chatId, 'wake');
    return;
  }

  // /claude <prompt> - run Claude with custom prompt
  if (lower.startsWith('/claude')) {
    const userPrompt = trimmed.slice(7).trim();
    if (!userPrompt) {
      await sendMessage('Usage: /claude <your prompt here>', chatId);
      return;
    }

    const claudePrompt = `You are the autonomous trader agent. Read MISSION.md for context.

User request via Telegram: ${userPrompt}

Execute this request, update relevant state files, and provide a summary of what you did.`;

    await spawnClaudeSession(claudePrompt, chatId, 'claude');
    return;
  }

  if (lower === '/ping' || lower === 'ping') {
    await sendMessage('pong', chatId);
    return;
  }

  // For everything else, add to inbox
  const contentType = detectContentType(trimmed);
  addToInbox(trimmed, contentType);

  const confirmations: Record<InboxItem['type'], string> = {
    link: `Added link to inbox. I'll review it.`,
    idea: `Got it. Added to inbox for processing.`,
    command: `Unknown command. Added to inbox.`,
    feedback: `Thanks for the feedback. Noted.`,
  };

  await sendMessage(confirmations[contentType], chatId);
}

// Main polling loop
export async function startHandler(): Promise<void> {
  console.log('Telegram handler starting...');

  await pollMessages(async (msg) => {
    console.log(`Received: ${msg.text}`);
    try {
      await handleMessage(msg.text, msg.chatId);
    } catch (error) {
      console.error('Error handling message:', error);
      await sendMessage('Error processing your message. Check logs.', msg.chatId);
    }
  });
}

if (require.main === module) {
  startHandler();
}
