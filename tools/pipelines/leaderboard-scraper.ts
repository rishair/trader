#!/usr/bin/env npx ts-node
/**
 * Leaderboard Scraper Pipeline
 *
 * Uses Firecrawl to scrape Polymarket leaderboard.
 * Stores results in state/trading/leaderboard/
 */

import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
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

async function scrapeWithFirecrawl(url: string): Promise<string> {
  if (!FIRECRAWL_API_KEY) {
    throw new Error('FIRECRAWL_API_KEY not set');
  }

  console.log(`Scraping ${url}...`);

  const response = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${FIRECRAWL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url,
      formats: ['markdown'],
      waitFor: 3000,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Firecrawl API error: ${response.status} - ${error}`);
  }

  const data = await response.json() as { success: boolean; data?: { markdown?: string } };

  if (!data.success || !data.data?.markdown) {
    throw new Error(`Firecrawl extraction failed: ${JSON.stringify(data)}`);
  }

  return data.data.markdown;
}

function parseLeaderboardMarkdown(markdown: string): LeaderboardEntry[] {
  const traders: LeaderboardEntry[] = [];
  const lines = markdown.split('\n');

  let currentRank = 0;
  let currentUsername = '';
  let currentWallet = '';
  let currentProfit = '';
  let currentVolume = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Match rank number (1-20 at start of line)
    const rankMatch = line.match(/^(\d{1,2})$/);
    if (rankMatch && parseInt(rankMatch[1]) >= 1 && parseInt(rankMatch[1]) <= 20) {
      // Save previous trader if exists
      if (currentRank > 0 && currentUsername) {
        traders.push({
          rank: currentRank,
          username: currentUsername,
          walletAddress: currentWallet,
          profit: parseFloat(currentProfit.replace(/[$,+]/g, '')) || 0,
          volume: parseFloat(currentVolume.replace(/[$,—]/g, '')) || 0,
          scrapedAt: new Date().toISOString(),
        });
      }
      currentRank = parseInt(rankMatch[1]);
      currentUsername = '';
      currentWallet = '';
      currentProfit = '';
      currentVolume = '';
      continue;
    }

    // Match username link: [username](profile_url)
    const usernameMatch = line.match(/\[([^\]]+)\]\(https:\/\/polymarket\.com\/profile\/(0x[a-f0-9]+)\)/i);
    if (usernameMatch && currentRank > 0 && !currentUsername) {
      currentUsername = usernameMatch[1];
      currentWallet = usernameMatch[2];
      continue;
    }

    // Match profit: +$1,234,567
    const profitMatch = line.match(/^\+?\$[\d,]+$/);
    if (profitMatch && currentRank > 0 && currentUsername && !currentProfit) {
      currentProfit = profitMatch[0];
      continue;
    }

    // Match volume: $1,234,567 or —
    const volumeMatch = line.match(/^\$[\d,]+$|^—$/);
    if (volumeMatch && currentRank > 0 && currentUsername && currentProfit && !currentVolume) {
      currentVolume = volumeMatch[0];
      continue;
    }

    // Stop at "Biggest wins" section
    if (line.includes('Biggest wins')) {
      break;
    }
  }

  // Save last trader
  if (currentRank > 0 && currentUsername) {
    traders.push({
      rank: currentRank,
      username: currentUsername,
      walletAddress: currentWallet,
      profit: parseFloat(currentProfit.replace(/[$,+]/g, '')) || 0,
      volume: parseFloat(currentVolume.replace(/[$,—]/g, '')) || 0,
      scrapedAt: new Date().toISOString(),
    });
  }

  return traders;
}

async function scrapeLeaderboard(timeframe: 'day' | 'week' | 'month' | 'all' = 'week'): Promise<LeaderboardData> {
  console.log(`Scraping ${timeframe} leaderboard...`);

  // Map timeframe to URL path
  const timeframePath = timeframe === 'day' ? 'daily' :
                        timeframe === 'week' ? 'weekly' :
                        timeframe === 'month' ? 'monthly' : 'all';

  const url = `https://polymarket.com/leaderboard/overall/${timeframePath}/profit`;

  const markdown = await scrapeWithFirecrawl(url);
  const traders = parseLeaderboardMarkdown(markdown);

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
    data.traders.slice(0, 5).forEach((t) => {
      console.log(`${t.rank}. ${t.username}: $${t.profit.toLocaleString()} profit, $${t.volume.toLocaleString()} volume`);
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
