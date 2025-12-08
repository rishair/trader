#!/usr/bin/env npx ts-node
/**
 * Trader Profile Analyzer
 *
 * Fetches trade history for top performers and analyzes their patterns.
 * Generates hypotheses based on what makes them successful.
 */

import * as fs from 'fs';
import * as path from 'path';

const STATE_DIR = path.join(__dirname, '../../state/trading');
const LEADERBOARD_DIR = path.join(STATE_DIR, 'leaderboard');

interface Trade {
  id: string;
  market: string;
  asset: string;
  side: 'BUY' | 'SELL';
  size: number;
  price: number;
  timestamp: string;
  outcome: string;
  eventSlug?: string;
  eventTitle?: string;
}

interface TraderProfile {
  walletAddress: string;
  username: string;
  weeklyProfit: number;
  weeklyVolume: number;
  trades: Trade[];
  analysis: {
    totalTrades: number;
    uniqueMarkets: number;
    avgTradeSize: number;
    buyVsSellRatio: number;
    marketCategories: Record<string, number>;
    timeOfDayDistribution: Record<string, number>;
    avgEntryPrice: number;
    largestTrade: number;
    tradingFrequency: string;
  };
  patterns: string[];
  fetchedAt: string;
}

async function fetchTraderTrades(walletAddress: string, limit = 500): Promise<Trade[]> {
  console.log(`  Fetching trades for ${walletAddress.slice(0, 10)}...`);

  const url = `https://data-api.polymarket.com/trades?user=${walletAddress}&limit=${limit}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  const data = await response.json() as any[];

  return data.map((t: any) => ({
    id: t.id || t.tradeId,
    market: t.market || t.conditionId,
    asset: t.asset || t.tokenId,
    side: t.side,
    size: parseFloat(t.size || t.amount || '0'),
    price: parseFloat(t.price || '0'),
    timestamp: t.timestamp || t.createdAt,
    outcome: t.outcome || t.outcomeName || '',
    eventSlug: t.eventSlug,
    eventTitle: t.eventTitle || t.title,
  }));
}

async function fetchMarketDetails(conditionId: string): Promise<any> {
  try {
    const url = `https://clob.polymarket.com/markets/${conditionId}`;
    const response = await fetch(url);
    if (response.ok) {
      return await response.json();
    }
  } catch {
    // Ignore errors
  }
  return null;
}

function categorizeMarket(title: string): string {
  const lower = title.toLowerCase();
  if (lower.includes('nfl') || lower.includes('nba') || lower.includes('mlb') ||
      lower.includes('ufc') || lower.includes('vs.') || lower.includes('game') ||
      lower.includes('match') || lower.includes('championship') || lower.includes('bowl')) {
    return 'sports';
  }
  if (lower.includes('trump') || lower.includes('biden') || lower.includes('election') ||
      lower.includes('president') || lower.includes('congress') || lower.includes('senate')) {
    return 'politics';
  }
  if (lower.includes('bitcoin') || lower.includes('btc') || lower.includes('eth') ||
      lower.includes('crypto') || lower.includes('price')) {
    return 'crypto';
  }
  if (lower.includes('fed') || lower.includes('rate') || lower.includes('inflation') ||
      lower.includes('gdp') || lower.includes('economic')) {
    return 'economics';
  }
  return 'other';
}

function analyzeTrader(trades: Trade[], username: string, walletAddress: string, profit: number, volume: number): TraderProfile {
  const uniqueMarkets = new Set(trades.map(t => t.market));
  const buys = trades.filter(t => t.side === 'BUY');
  const sells = trades.filter(t => t.side === 'SELL');

  // Categorize markets
  const marketCategories: Record<string, number> = {};
  trades.forEach(t => {
    const category = categorizeMarket(t.eventTitle || t.outcome || '');
    marketCategories[category] = (marketCategories[category] || 0) + 1;
  });

  // Time of day distribution (UTC hours)
  const timeDistribution: Record<string, number> = {
    'morning (6-12)': 0,
    'afternoon (12-18)': 0,
    'evening (18-24)': 0,
    'night (0-6)': 0,
  };
  trades.forEach(t => {
    const hour = new Date(t.timestamp).getUTCHours();
    if (hour >= 6 && hour < 12) timeDistribution['morning (6-12)']++;
    else if (hour >= 12 && hour < 18) timeDistribution['afternoon (12-18)']++;
    else if (hour >= 18 && hour < 24) timeDistribution['evening (18-24)']++;
    else timeDistribution['night (0-6)']++;
  });

  const tradeSizes = trades.map(t => t.size * t.price);
  const avgTradeSize = tradeSizes.length > 0 ? tradeSizes.reduce((a, b) => a + b, 0) / tradeSizes.length : 0;
  const largestTrade = Math.max(...tradeSizes, 0);

  // Trading frequency
  let tradingFrequency = 'unknown';
  if (trades.length > 0) {
    const firstTrade = new Date(trades[trades.length - 1].timestamp);
    const lastTrade = new Date(trades[0].timestamp);
    const daysDiff = (lastTrade.getTime() - firstTrade.getTime()) / (1000 * 60 * 60 * 24);
    const tradesPerDay = daysDiff > 0 ? trades.length / daysDiff : trades.length;

    if (tradesPerDay > 20) tradingFrequency = 'very high (20+/day)';
    else if (tradesPerDay > 10) tradingFrequency = 'high (10-20/day)';
    else if (tradesPerDay > 5) tradingFrequency = 'medium (5-10/day)';
    else if (tradesPerDay > 1) tradingFrequency = 'low (1-5/day)';
    else tradingFrequency = 'very low (<1/day)';
  }

  // Generate patterns
  const patterns: string[] = [];

  // Dominant category
  const sortedCategories = Object.entries(marketCategories).sort((a, b) => b[1] - a[1]);
  if (sortedCategories.length > 0 && sortedCategories[0][1] > trades.length * 0.5) {
    patterns.push(`Specializes in ${sortedCategories[0][0]} markets (${Math.round(sortedCategories[0][1] / trades.length * 100)}% of trades)`);
  }

  // Buy/sell ratio
  const buyRatio = buys.length / (buys.length + sells.length);
  if (buyRatio > 0.7) {
    patterns.push('Heavily favors buying (long bias)');
  } else if (buyRatio < 0.3) {
    patterns.push('Heavily favors selling (short/exit bias)');
  }

  // Trade size patterns
  if (largestTrade > avgTradeSize * 5) {
    patterns.push('Makes occasional very large bets (concentrated conviction)');
  }

  // Time patterns
  const peakTime = Object.entries(timeDistribution).sort((a, b) => b[1] - a[1])[0];
  if (peakTime[1] > trades.length * 0.4) {
    patterns.push(`Most active during ${peakTime[0]} UTC`);
  }

  // Market concentration
  if (uniqueMarkets.size < 5 && trades.length > 20) {
    patterns.push('Highly concentrated - few markets, many trades');
  } else if (uniqueMarkets.size > trades.length * 0.5) {
    patterns.push('Diversified - spreads across many markets');
  }

  return {
    walletAddress,
    username,
    weeklyProfit: profit,
    weeklyVolume: volume,
    trades,
    analysis: {
      totalTrades: trades.length,
      uniqueMarkets: uniqueMarkets.size,
      avgTradeSize,
      buyVsSellRatio: buyRatio,
      marketCategories,
      timeOfDayDistribution: timeDistribution,
      avgEntryPrice: trades.length > 0 ? trades.map(t => t.price).reduce((a, b) => a + b, 0) / trades.length : 0,
      largestTrade,
      tradingFrequency,
    },
    patterns,
    fetchedAt: new Date().toISOString(),
  };
}

function generateHypotheses(profiles: TraderProfile[]): string[] {
  const hypotheses: string[] = [];

  // Check for common patterns across top traders
  const allPatterns = profiles.flatMap(p => p.patterns);
  const patternCounts: Record<string, number> = {};
  allPatterns.forEach(p => {
    patternCounts[p] = (patternCounts[p] || 0) + 1;
  });

  // Category concentration
  const categoryFocus: Record<string, number> = {};
  profiles.forEach(p => {
    const topCategory = Object.entries(p.analysis.marketCategories).sort((a, b) => b[1] - a[1])[0];
    if (topCategory) {
      categoryFocus[topCategory[0]] = (categoryFocus[topCategory[0]] || 0) + 1;
    }
  });

  const dominantCategory = Object.entries(categoryFocus).sort((a, b) => b[1] - a[1])[0];
  if (dominantCategory && dominantCategory[1] >= profiles.length * 0.5) {
    hypotheses.push(`HYPOTHESIS: ${dominantCategory[0].toUpperCase()} markets may offer better edge - ${dominantCategory[1]}/${profiles.length} top traders focus here`);
  }

  // Trade frequency patterns
  const highFreqTraders = profiles.filter(p =>
    p.analysis.tradingFrequency.includes('high') || p.analysis.tradingFrequency.includes('very high')
  );
  if (highFreqTraders.length >= profiles.length * 0.5) {
    hypotheses.push(`HYPOTHESIS: High-frequency trading (10+ trades/day) correlates with top performance`);
  }

  // Concentration patterns
  const concentratedTraders = profiles.filter(p => p.analysis.uniqueMarkets < 10);
  if (concentratedTraders.length >= profiles.length * 0.5) {
    hypotheses.push(`HYPOTHESIS: Market concentration (< 10 markets) beats diversification`);
  }

  // Size patterns
  const bigBetters = profiles.filter(p => p.analysis.largestTrade > p.analysis.avgTradeSize * 5);
  if (bigBetters.length >= profiles.length * 0.5) {
    hypotheses.push(`HYPOTHESIS: Top traders make concentrated high-conviction bets (5x+ average size)`);
  }

  // Time patterns
  const timePreferences: Record<string, number> = {};
  profiles.forEach(p => {
    const peakTime = Object.entries(p.analysis.timeOfDayDistribution).sort((a, b) => b[1] - a[1])[0];
    if (peakTime) {
      timePreferences[peakTime[0]] = (timePreferences[peakTime[0]] || 0) + 1;
    }
  });
  const peakTradingTime = Object.entries(timePreferences).sort((a, b) => b[1] - a[1])[0];
  if (peakTradingTime && peakTradingTime[1] >= profiles.length * 0.4) {
    hypotheses.push(`HYPOTHESIS: Trading during ${peakTradingTime[0]} may offer timing advantage`);
  }

  return hypotheses;
}

async function main() {
  console.log('=== TRADER PROFILE ANALYZER ===\n');

  // Load latest leaderboard
  const leaderboardFile = path.join(LEADERBOARD_DIR, 'week-latest.json');
  if (!fs.existsSync(leaderboardFile)) {
    console.error('No leaderboard data found. Run leaderboard-scraper first.');
    process.exit(1);
  }

  const leaderboard = JSON.parse(fs.readFileSync(leaderboardFile, 'utf-8'));
  const topTraders = leaderboard.traders.slice(0, 5);

  console.log(`Analyzing top ${topTraders.length} traders from ${leaderboard.timeframe} leaderboard:\n`);

  const profiles: TraderProfile[] = [];

  for (const trader of topTraders) {
    console.log(`\n${trader.rank}. ${trader.username} (+$${trader.profit.toLocaleString()})`);

    try {
      const trades = await fetchTraderTrades(trader.walletAddress);
      const profile = analyzeTrader(trades, trader.username, trader.walletAddress, trader.profit, trader.volume);
      profiles.push(profile);

      console.log(`   Trades: ${profile.analysis.totalTrades} | Markets: ${profile.analysis.uniqueMarkets} | Freq: ${profile.analysis.tradingFrequency}`);
      console.log(`   Avg size: $${Math.round(profile.analysis.avgTradeSize).toLocaleString()} | Largest: $${Math.round(profile.analysis.largestTrade).toLocaleString()}`);
      console.log(`   Categories: ${Object.entries(profile.analysis.marketCategories).map(([k, v]) => `${k}:${v}`).join(', ')}`);

      if (profile.patterns.length > 0) {
        console.log(`   Patterns:`);
        profile.patterns.forEach(p => console.log(`     - ${p}`));
      }

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 500));
    } catch (err: any) {
      console.log(`   Error: ${err.message}`);
    }
  }

  // Generate hypotheses
  console.log('\n\n=== GENERATED HYPOTHESES ===\n');
  const hypotheses = generateHypotheses(profiles);

  if (hypotheses.length === 0) {
    console.log('Not enough consistent patterns found. Need more data or diverse sample.');
  } else {
    hypotheses.forEach((h, i) => console.log(`${i + 1}. ${h}`));
  }

  // Save analysis
  const outputFile = path.join(LEADERBOARD_DIR, 'trader-analysis.json');
  fs.writeFileSync(outputFile, JSON.stringify({
    analyzedAt: new Date().toISOString(),
    leaderboardTimeframe: leaderboard.timeframe,
    profiles,
    hypotheses,
  }, null, 2));

  console.log(`\nAnalysis saved to ${outputFile}`);

  return { profiles, hypotheses };
}

export { fetchTraderTrades, analyzeTrader, generateHypotheses };
export type { TraderProfile };

if (require.main === module) {
  main();
}
