#!/usr/bin/env npx ts-node
/**
 * Leaderboard Scraper Pipeline
 *
 * Uses Apify's Polymarket Leaderboard Scraper to fetch top traders.
 * Stores results in state/trading/leaderboard/
 */

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
const ACTOR_ID = 'saswave~polymarket-leaderboard-scraper';
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

async function runApifyActor(input: any): Promise<any> {
  if (!APIFY_TOKEN) {
    throw new Error('APIFY_API_TOKEN not set');
  }

  // Start the actor run synchronously (waits up to 5 min)
  const runUrl = `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;

  const response = await fetch(runUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Apify API error: ${response.status} - ${error}`);
  }

  return response.json();
}

async function scrapeLeaderboard(timeframe: 'day' | 'week' | 'month' | 'all' = 'week'): Promise<LeaderboardData> {
  console.log(`Scraping ${timeframe} leaderboard...`);

  const input = {
    filter: 'profit',  // Sort by profit
    timeRange: timeframe,
    maxItems: 20,  // Top 20 traders
  };

  const results = await runApifyActor(input);

  const traders: LeaderboardEntry[] = results.map((item: any, index: number) => ({
    rank: index + 1,
    username: item.username || item.name || 'Anonymous',
    walletAddress: item.proxyWallet || item.wallet || item.address || '',
    profit: parseFloat(item.profit?.replace(/[$,]/g, '') || '0'),
    volume: parseFloat(item.volume?.replace(/[$,]/g, '') || '0'),
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
export { scrapeLeaderboard, saveLeaderboard, LeaderboardEntry, LeaderboardData };

// Run if called directly
if (require.main === module) {
  main();
}
