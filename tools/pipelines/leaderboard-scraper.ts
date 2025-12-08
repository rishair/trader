#!/usr/bin/env npx ts-node
/**
 * Leaderboard Scraper Pipeline
 *
 * Uses Browser Use Cloud to scrape Polymarket leaderboard.
 * Stores results in state/trading/leaderboard/
 */

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const BROWSER_USE_API_KEY = process.env.BROWSER_USE_API_KEY;
const STATE_DIR = path.join(__dirname, '../../state/trading/leaderboard');

interface LeaderboardEntry {
  rank: number;
  username: string;
  walletAddress: string;
  profit: number;
  volume: number;
  scrapedAt: string;
}

interface LeaderboardData {
  timeframe: string;
  scrapedAt: string;
  traders: LeaderboardEntry[];
}

interface BrowserUseResponse {
  task_id: string;
  status: string;
  live_url?: string;
}

interface TaskStatusResponse {
  id: string;
  status: 'pending' | 'running' | 'finished' | 'failed' | 'stopped';
  output?: string;
  steps?: any[];
}

async function runBrowserTask(task: string): Promise<any> {
  if (!BROWSER_USE_API_KEY) {
    throw new Error('BROWSER_USE_API_KEY not set');
  }

  // Start the task
  console.log('Starting browser task...');
  const runResponse = await fetch('https://api.browser-use.com/api/v1/run-task', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${BROWSER_USE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      task,
      structured_output_json: JSON.stringify({
        type: 'object',
        properties: {
          traders: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                rank: { type: 'number' },
                username: { type: 'string' },
                walletAddress: { type: 'string' },
                profit: { type: 'string' },
                volume: { type: 'string' }
              }
            }
          }
        }
      }),
      use_adblock: true,
    }),
  });

  if (!runResponse.ok) {
    const error = await runResponse.text();
    throw new Error(`Browser Use API error: ${runResponse.status} - ${error}`);
  }

  const runData = await runResponse.json() as BrowserUseResponse;
  console.log(`Task started: ${runData.task_id}`);
  if (runData.live_url) {
    console.log(`Live preview: ${runData.live_url}`);
  }

  // Poll for completion
  const taskId = runData.task_id;
  let attempts = 0;
  const maxAttempts = 60; // 5 minutes max (5s intervals)

  while (attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5s
    attempts++;

    const statusResponse = await fetch(`https://api.browser-use.com/api/v1/task/${taskId}`, {
      headers: {
        'Authorization': `Bearer ${BROWSER_USE_API_KEY}`,
      },
    });

    if (!statusResponse.ok) {
      console.log(`Status check failed (attempt ${attempts}), retrying...`);
      continue;
    }

    const statusData = await statusResponse.json() as TaskStatusResponse;
    console.log(`Status: ${statusData.status} (attempt ${attempts}/${maxAttempts})`);

    if (statusData.status === 'finished') {
      return statusData.output ? JSON.parse(statusData.output) : statusData;
    } else if (statusData.status === 'failed' || statusData.status === 'stopped') {
      throw new Error(`Task ${statusData.status}: ${JSON.stringify(statusData)}`);
    }
  }

  throw new Error('Task timed out after 5 minutes');
}

async function scrapeLeaderboard(timeframe: 'day' | 'week' | 'month' | 'all' = 'week'): Promise<LeaderboardData> {
  console.log(`Scraping ${timeframe} leaderboard...`);

  const task = `
Go to https://polymarket.com/leaderboard

Click on the "${timeframe === 'day' ? 'Today' : timeframe === 'week' ? 'Weekly' : timeframe === 'month' ? 'Monthly' : 'All'}" tab to filter by timeframe.

Wait for the leaderboard to load.

Extract the top 20 traders from the leaderboard. For each trader, get:
- Their rank (1-20)
- Their username or display name
- Their wallet address (starts with 0x, may be truncated)
- Their profit amount (in USD)
- Their volume amount (in USD)

Return the data as a JSON object with a "traders" array containing objects with: rank, username, walletAddress, profit, volume
`;

  const result = await runBrowserTask(task);

  const traders: LeaderboardEntry[] = (result.traders || []).map((item: any, index: number) => ({
    rank: item.rank || index + 1,
    username: item.username || 'Anonymous',
    walletAddress: item.walletAddress || '',
    profit: parseFloat(String(item.profit || '0').replace(/[$,+]/g, '')),
    volume: parseFloat(String(item.volume || '0').replace(/[$,]/g, '')),
    scrapedAt: new Date().toISOString(),
  }));

  return {
    timeframe,
    scrapedAt: new Date().toISOString(),
    traders,
  };
}

function saveLeaderboard(data: LeaderboardData): void {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }

  // Save current snapshot
  const filename = `${data.timeframe}-latest.json`;
  fs.writeFileSync(
    path.join(STATE_DIR, filename),
    JSON.stringify(data, null, 2)
  );

  // Append to history
  const historyFile = path.join(STATE_DIR, `${data.timeframe}-history.json`);
  let history: LeaderboardData[] = [];
  if (fs.existsSync(historyFile)) {
    history = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
  }
  history.push(data);
  // Keep last 30 snapshots
  if (history.length > 30) {
    history = history.slice(-30);
  }
  fs.writeFileSync(historyFile, JSON.stringify(history, null, 2));

  console.log(`Saved ${data.traders.length} traders to ${filename}`);
}

async function main() {
  const timeframe = (process.argv[2] as 'day' | 'week' | 'month' | 'all') || 'week';

  try {
    const data = await scrapeLeaderboard(timeframe);
    saveLeaderboard(data);

    // Print top 5
    console.log(`\nTop 5 traders (${timeframe}):`);
    data.traders.slice(0, 5).forEach((t, i) => {
      console.log(`${i + 1}. ${t.username}: $${t.profit.toLocaleString()} profit, $${t.volume.toLocaleString()} volume`);
    });

    return data;
  } catch (error: any) {
    console.error('Scraping failed:', error.message);
    process.exit(1);
  }
}

// Export for use as module
export { scrapeLeaderboard, saveLeaderboard };
export type { LeaderboardEntry, LeaderboardData };

// Run if called directly
if (require.main === module) {
  main();
}
