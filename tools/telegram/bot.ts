import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

/**
 * Telegram MarkdownV2 Formatting Reference:
 *
 * *bold*                    → bold text
 * _italic_                  → italic text
 * __underline__             → underlined text
 * ~strikethrough~           → strikethrough text
 * ||spoiler||               → spoiler text
 * `code`                    → inline code
 * ```lang\ncode```          → code block with syntax highlighting
 * [text](url)               → inline link
 * >blockquote               → block quote (single line)
 * >multiline\n>blockquote   → block quote (multiple lines)
 *
 * Characters that MUST be escaped with \: _ * [ ] ( ) ~ ` > # + - = | { } . !
 *
 * Use escapeMarkdown() for user-provided text
 * Use raw MarkdownV2 syntax for formatted messages
 */

// Characters that must be escaped in MarkdownV2
const MARKDOWN_V2_SPECIAL_CHARS = /[_*[\]()~`>#+\-=|{}.!]/g;

/**
 * Escape special characters for MarkdownV2
 * Use this for any dynamic text that shouldn't be interpreted as formatting
 */
export function escapeMarkdown(text: string): string {
  return text.replace(MARKDOWN_V2_SPECIAL_CHARS, '\\$&');
}

/**
 * Format helpers for common patterns
 */
export const fmt = {
  bold: (text: string) => `*${escapeMarkdown(text)}*`,
  italic: (text: string) => `_${escapeMarkdown(text)}_`,
  underline: (text: string) => `__${escapeMarkdown(text)}__`,
  strike: (text: string) => `~${escapeMarkdown(text)}~`,
  spoiler: (text: string) => `||${escapeMarkdown(text)}||`,
  code: (text: string) => `\`${text.replace(/[`\\]/g, '\\$&')}\``,
  pre: (text: string, lang?: string) => lang
    ? `\`\`\`${lang}\n${text.replace(/[`\\]/g, '\\$&')}\n\`\`\``
    : `\`\`\`\n${text.replace(/[`\\]/g, '\\$&')}\n\`\`\``,
  link: (text: string, url: string) => `[${escapeMarkdown(text)}](${url.replace(/[)\\]/g, '\\$&')})`,
  quote: (text: string) => text.split('\n').map(line => `>${escapeMarkdown(line)}`).join('\n'),
  // Raw - use when you're building formatted strings manually
  raw: (text: string) => text,
};

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

export interface SendMessageOptions {
  parseMode?: 'MarkdownV2' | 'Markdown' | 'HTML' | null;
  disableWebPagePreview?: boolean;
}

export async function sendMessage(
  text: string,
  chatId?: string,
  options: SendMessageOptions = {}
): Promise<number | null> {
  const targetChatId = chatId || getChatId();
  if (!targetChatId) {
    console.error('No chat ID available. User needs to message the bot first.');
    return null;
  }

  const { parseMode = 'MarkdownV2', disableWebPagePreview = false } = options;

  try {
    const response = await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: targetChatId,
      text,
      ...(parseMode && { parse_mode: parseMode }),
      ...(disableWebPagePreview && { disable_web_page_preview: true }),
    });
    return response.data.result?.message_id || null;
  } catch (error: any) {
    // If MarkdownV2 parsing failed, try without parse_mode as fallback
    if (parseMode && error.response?.data?.description?.includes("can't parse")) {
      console.warn('MarkdownV2 parse failed, retrying without formatting');
      try {
        const response = await axios.post(`${TELEGRAM_API}/sendMessage`, {
          chat_id: targetChatId,
          text,
          ...(disableWebPagePreview && { disable_web_page_preview: true }),
        });
        return response.data.result?.message_id || null;
      } catch (retryError: any) {
        console.error('Failed to send message (retry):', retryError.response?.data || retryError.message);
        return null;
      }
    }
    console.error('Failed to send Telegram message:', error.response?.data || error.message);
    return null;
  }
}

export async function editMessage(
  messageId: number,
  text: string,
  chatId?: string,
  options: SendMessageOptions = {}
): Promise<boolean> {
  const targetChatId = chatId || getChatId();
  if (!targetChatId) {
    console.error('No chat ID available.');
    return false;
  }

  const { parseMode = 'MarkdownV2', disableWebPagePreview = false } = options;

  try {
    await axios.post(`${TELEGRAM_API}/editMessageText`, {
      chat_id: targetChatId,
      message_id: messageId,
      text,
      ...(parseMode && { parse_mode: parseMode }),
      ...(disableWebPagePreview && { disable_web_page_preview: true }),
    });
    return true;
  } catch (error: any) {
    // Telegram returns error if message content is identical - ignore it
    if (error.response?.data?.description?.includes('message is not modified')) {
      return true;
    }

    // If MarkdownV2 parsing failed, try without parse_mode
    if (parseMode && error.response?.data?.description?.includes("can't parse")) {
      console.warn('MarkdownV2 parse failed on edit, retrying without formatting');
      try {
        await axios.post(`${TELEGRAM_API}/editMessageText`, {
          chat_id: targetChatId,
          message_id: messageId,
          text,
          ...(disableWebPagePreview && { disable_web_page_preview: true }),
        });
        return true;
      } catch (retryError: any) {
        console.error('Failed to edit message (retry):', retryError.response?.data || retryError.message);
        return false;
      }
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
