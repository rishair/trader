#!/usr/bin/env npx ts-node
/**
 * Sync Telegram Bot Commands
 *
 * Reads commands from handler.ts and updates the bot's command menu.
 * Run after modifying telegram commands.
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// Command definitions - keep in sync with handler.ts
const COMMANDS = [
  // Chat
  { command: 'new', description: 'Start a fresh conversation' },
  { command: 'session', description: 'Show current session info' },

  // Info
  { command: 'status', description: 'Current system status' },
  { command: 'pending', description: 'Show pending approvals' },
  { command: 'errors', description: 'Recent errors' },
  { command: 'ps', description: 'Running processes' },
  { command: 'version', description: 'Show version and recent commits' },
  { command: 'help', description: 'Show all commands' },

  // Approvals
  { command: 'approve', description: 'Approve a pending item' },
  { command: 'reject', description: 'Reject a pending item' },
  { command: 'execute', description: 'Re-run an approved item' },

  // Actions
  { command: 'wake', description: 'Run next scheduled task' },
  { command: 'process', description: 'Process inbox items' },
  { command: 'inbox', description: 'Add content to inbox' },
  { command: 'heal', description: 'AI-analyze and fix errors' },
  { command: 'start', description: 'Start the daemon' },
  { command: 'stop', description: 'Stop the daemon' },
  { command: 'rollback', description: 'Rollback to a commit and redeploy' },
];

async function syncCommands() {
  if (!TELEGRAM_TOKEN) {
    console.error('TELEGRAM_BOT_TOKEN not set');
    process.exit(1);
  }

  try {
    const response = await axios.post(`${TELEGRAM_API}/setMyCommands`, {
      commands: COMMANDS,
    });

    if (response.data.ok) {
      console.log(`✅ Synced ${COMMANDS.length} commands to Telegram`);
      console.log('Commands:');
      COMMANDS.forEach(c => console.log(`  /${c.command} - ${c.description}`));
    } else {
      console.error('Failed:', response.data);
      process.exit(1);
    }
  } catch (error: any) {
    console.error('Error:', error.response?.data || error.message);
    process.exit(1);
  }
}

syncCommands();
