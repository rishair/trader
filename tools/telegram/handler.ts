import * as fs from 'fs';
import * as path from 'path';
import { sendMessage, pollMessages } from './bot';

const STATE_DIR = path.join(__dirname, '../../state');
const INBOX_FILE = path.join(STATE_DIR, 'inbox.json');
const STATUS_FILE = path.join(STATE_DIR, 'status.md');

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
