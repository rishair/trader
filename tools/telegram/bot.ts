import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// Store chat ID after first message from user
const CHAT_ID_FILE = path.join(__dirname, '../../state/telegram_chat_id.txt');

function getChatId(): string | null {
  try {
    return fs.readFileSync(CHAT_ID_FILE, 'utf-8').trim();
  } catch {
    return null;
  }
}

function saveChatId(chatId: string): void {
  fs.writeFileSync(CHAT_ID_FILE, chatId);
}

export async function sendMessage(text: string, chatId?: string): Promise<number | null> {
  const targetChatId = chatId || getChatId();
  if (!targetChatId) {
    console.error('No chat ID available. User needs to message the bot first.');
    return null;
  }

  try {
    const response = await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: targetChatId,
      text,
      parse_mode: 'Markdown',
    });
    return response.data.result?.message_id || null;
  } catch (error: any) {
    console.error('Failed to send Telegram message:', error.response?.data || error.message);
    return null;
  }
}

export async function editMessage(messageId: number, text: string, chatId?: string): Promise<boolean> {
  const targetChatId = chatId || getChatId();
  if (!targetChatId) {
    console.error('No chat ID available.');
    return false;
  }

  try {
    await axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id: targetChatId,
      message_id: messageId,
      text,
      parse_mode: 'Markdown',
    });
    return true;
  } catch (error: any) {
    // Telegram returns error if message content is identical - ignore it
    if (error.response?.data?.description?.includes('message is not modified')) {
      return true;
    }
    console.error('Failed to edit Telegram message:', error.response?.data || error.message);
    return false;
  }
}

export async function getUpdates(offset?: number): Promise<any[]> {
  try {
    const response = await axios.get(`${TELEGRAM_API}/getUpdates`, {
      params: {
        offset,
        timeout: 30, // Long polling
      },
    });
    return response.data.result || [];
  } catch (error: any) {
    console.error('Failed to get updates:', error.response?.data || error.message);
    return [];
  }
}

interface IncomingMessage {
  updateId: number;
  chatId: string;
  text: string;
  from: string;
  date: Date;
}

export async function pollMessages(callback: (msg: IncomingMessage) => void): Promise<void> {
  let lastUpdateId: number | undefined;

  console.log('Starting Telegram polling...');

  while (true) {
    const updates = await getUpdates(lastUpdateId);

    for (const update of updates) {
      lastUpdateId = update.update_id + 1;

      if (update.message?.text) {
        const msg = update.message;

        // Save chat ID on first message
        saveChatId(msg.chat.id.toString());

        callback({
          updateId: update.update_id,
          chatId: msg.chat.id.toString(),
          text: msg.text,
          from: msg.from?.username || msg.from?.first_name || 'unknown',
          date: new Date(msg.date * 1000),
        });
      }
    }
  }
}

// CLI interface
if (require.main === module) {
  const command = process.argv[2];
  const message = process.argv.slice(3).join(' ');

  if (command === 'send' && message) {
    sendMessage(message).then((success) => {
      process.exit(success ? 0 : 1);
    });
  } else if (command === 'poll') {
    pollMessages((msg) => {
      console.log(`[${msg.date.toISOString()}] ${msg.from}: ${msg.text}`);
    });
  } else if (command === 'chat-id') {
    const chatId = getChatId();
    console.log(chatId || 'No chat ID saved. Message the bot first.');
  } else {
    console.log(`
Usage:
  ts-node bot.ts send <message>    Send a message
  ts-node bot.ts poll              Poll for incoming messages
  ts-node bot.ts chat-id           Show saved chat ID
    `);
  }
}
