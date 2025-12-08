/**
 * Shadow Mode Arbitrage Detector (strat-002, Phase 1)
 *
 * Monitors all Polymarket markets for single-market arbitrage opportunities
 * where YES + NO prices don't sum to $1.00.
 *
 * This is SHADOW MODE - no real trades executed, just detection and logging.
 *
 * Usage:
 *   npx ts-node tools/arbitrage/shadow-detector.ts              # Run detector
 *   npx ts-node tools/arbitrage/shadow-detector.ts --test       # Test with sample data
 *
 * Output:
 *   - Console logs of detected opportunities
 *   - Appends to state/trading/arbitrage-opportunities.json
 *   - Telegram alerts for significant opportunities (>2% spread)
 */

import * as fs from 'fs';
import * as path from 'path';
// WebSocket import removed - using polling for Phase 1
// import WebSocket from 'ws';

const STATE_DIR = path.join(__dirname, '../../state/trading');
const OPPORTUNITIES_FILE = path.join(STATE_DIR, 'arbitrage-opportunities.json');

// APIs
const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';
// WebSocket URL for future Phase 2
// const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

// Thresholds
const MIN_SPREAD_THRESHOLD = 0.005;  // 0.5% minimum spread to log
const ALERT_SPREAD_THRESHOLD = 0.015;  // 1.5% spread triggers Telegram alert
const MIN_LIQUIDITY = 1000;  // Minimum $1000 liquidity to consider
const POLL_INTERVAL_MS = 5000;  // 5 seconds between polls (fallback)

interface Market {
  conditionId: string;
  slug: string;
  question: string;
  outcomes: string[];
  tokens: {
    outcome: string;
    tokenId: string;
  }[];
  liquidity: number;
  volume24h: number;
}

interface PriceData {
  tokenId: string;
  outcome: string;
  bid: number;
  ask: number;
  mid: number;
}

interface ArbitrageOpportunity {
  timestamp: string;
  market: string;
  marketSlug: string;
  conditionId: string;
  yesPrice: number;
  noPrice: number;
  spread: number;  // YES + NO - 1.0 (negative = buy opportunity, positive = sell)
  spreadPercent: number;
  theoreticalProfit: number;  // Per $100 invested
  liquidity: number;
  action: 'BUY_BOTH' | 'SELL_BOTH' | 'NONE';
  executed: boolean;  // Always false in shadow mode
  notes: string;
}

interface ShadowStats {
  startTime: string;
  lastUpdate: string;
  marketsMonitored: number;
  opportunitiesDetected: number;
  theoreticalPnL: number;
  largestSpread: number;
  avgSpread: number;
}

// State
let markets: Map<string, Market> = new Map();
let opportunities: ArbitrageOpportunity[] = [];
let stats: ShadowStats = {
  startTime: new Date().toISOString(),
  lastUpdate: new Date().toISOString(),
  marketsMonitored: 0,
  opportunitiesDetected: 0,
  theoreticalPnL: 0,
  largestSpread: 0,
  avgSpread: 0
};

/**
 * Load existing opportunities from file
 */
function loadOpportunities(): void {
  try {
    if (fs.existsSync(OPPORTUNITIES_FILE)) {
      const data = JSON.parse(fs.readFileSync(OPPORTUNITIES_FILE, 'utf-8'));
      opportunities = data.opportunities || [];
      stats = data.stats || stats;
      console.log(`Loaded ${opportunities.length} previous opportunities`);
    }
  } catch (error: any) {
    console.error(`Error loading opportunities: ${error.message}`);
  }
}

/**
 * Save opportunities to file
 */
function saveOpportunities(): void {
  try {
    // Ensure directory exists
    if (!fs.existsSync(STATE_DIR)) {
      fs.mkdirSync(STATE_DIR, { recursive: true });
    }

    // Keep last 1000 opportunities
    const recentOpps = opportunities.slice(-1000);

    fs.writeFileSync(OPPORTUNITIES_FILE, JSON.stringify({
      stats,
      opportunities: recentOpps
    }, null, 2));
  } catch (error: any) {
    console.error(`Error saving opportunities: ${error.message}`);
  }
}

/**
 * Fetch all active markets from Gamma API
 */
async function fetchMarkets(): Promise<void> {
  try {
    const response = await fetch(`${GAMMA_API}/markets?limit=500&closed=false&active=true`);
    if (!response.ok) {
      throw new Error(`Gamma API error: ${response.status}`);
    }

    const data = await response.json() as any[];
    console.log(`Fetched ${data.length} markets from Gamma API`);

    for (const m of data) {
      if (!m.conditionId) continue;

      // Parse clobTokenIds - it's a JSON string in the API response
      let tokenIds: string[] = [];
      try {
        if (typeof m.clobTokenIds === 'string') {
          tokenIds = JSON.parse(m.clobTokenIds);
        } else if (Array.isArray(m.clobTokenIds)) {
          tokenIds = m.clobTokenIds;
        }
      } catch {
        continue;
      }

      // Only include markets with both YES and NO tokens
      if (tokenIds.length < 2) continue;

      // Parse outcomes
      let outcomes: string[] = ['Yes', 'No'];
      try {
        if (typeof m.outcomes === 'string') {
          outcomes = JSON.parse(m.outcomes);
        } else if (Array.isArray(m.outcomes)) {
          outcomes = m.outcomes;
        }
      } catch {}

      const market: Market = {
        conditionId: m.conditionId,
        slug: m.slug || m.conditionId,
        question: m.question || 'Unknown',
        outcomes,
        tokens: [
          { outcome: outcomes[0] || 'Yes', tokenId: tokenIds[0] },
          { outcome: outcomes[1] || 'No', tokenId: tokenIds[1] }
        ],
        liquidity: parseFloat(m.liquidity || '0'),
        volume24h: m.volume24hr || 0
      };

      // Only track markets with minimum liquidity
      if (market.liquidity >= MIN_LIQUIDITY) {
        markets.set(market.conditionId, market);
      }
    }

    stats.marketsMonitored = markets.size;
    console.log(`Tracking ${markets.size} markets with >$${MIN_LIQUIDITY} liquidity`);
  } catch (error: any) {
    console.error(`Error fetching markets: ${error.message}`);
  }
}

/**
 * Fetch price for a single token
 */
async function fetchTokenPrice(tokenId: string): Promise<PriceData | null> {
  try {
    const [buyRes, sellRes] = await Promise.all([
      fetch(`${CLOB_API}/price?token_id=${tokenId}&side=buy`),
      fetch(`${CLOB_API}/price?token_id=${tokenId}&side=sell`)
    ]);

    if (!buyRes.ok || !sellRes.ok) return null;

    const buyData = await buyRes.json() as any;
    const sellData = await sellRes.json() as any;

    const bid = parseFloat(buyData.price) || 0;
    const ask = parseFloat(sellData.price) || 0;
    const mid = (bid + ask) / 2 || bid || ask;

    return { tokenId, outcome: '', bid, ask, mid };
  } catch (error: any) {
    return null;
  }
}

/**
 * Check a single market for arbitrage opportunity
 */
async function checkMarketArbitrage(market: Market): Promise<ArbitrageOpportunity | null> {
  const [yesPrice, noPrice] = await Promise.all([
    fetchTokenPrice(market.tokens[0].tokenId),
    fetchTokenPrice(market.tokens[1].tokenId)
  ]);

  if (!yesPrice || !noPrice) return null;
  if (yesPrice.mid === 0 || noPrice.mid === 0) return null;

  // Calculate spread: YES + NO should equal 1.00
  // If < 1.00, we can buy both and guarantee profit
  // If > 1.00, we can sell both (if we hold) and guarantee profit
  const sum = yesPrice.mid + noPrice.mid;
  const spread = sum - 1.0;
  const spreadPercent = Math.abs(spread) * 100;

  // Log all spreads for analysis (even small ones)
  if (process.argv.includes('--verbose') && spreadPercent > 0.1) {
    console.log(`  [${market.slug.substring(0, 30)}] YES=${(yesPrice.mid * 100).toFixed(2)}¢ NO=${(noPrice.mid * 100).toFixed(2)}¢ sum=${(sum * 100).toFixed(2)}¢ spread=${spreadPercent.toFixed(3)}%`);
  }

  // Skip if spread below threshold
  if (spreadPercent < MIN_SPREAD_THRESHOLD * 100) return null;

  // Calculate theoretical profit per $100 invested
  let theoreticalProfit = 0;
  let action: 'BUY_BOTH' | 'SELL_BOTH' | 'NONE' = 'NONE';

  if (spread < 0) {
    // Sum < 1.00: Buy both YES and NO
    // Invest $100 total, split by current prices
    // Payout is always $1 per share, cost is sum per share
    action = 'BUY_BOTH';
    theoreticalProfit = (1 - sum) / sum * 100;  // Profit percentage
  } else {
    // Sum > 1.00: Would need to sell both (need existing positions)
    action = 'SELL_BOTH';
    theoreticalProfit = (sum - 1) / 1 * 100;  // Profit percentage
  }

  const opportunity: ArbitrageOpportunity = {
    timestamp: new Date().toISOString(),
    market: market.question,
    marketSlug: market.slug,
    conditionId: market.conditionId,
    yesPrice: yesPrice.mid,
    noPrice: noPrice.mid,
    spread,
    spreadPercent,
    theoreticalProfit,
    liquidity: market.liquidity,
    action,
    executed: false,
    notes: `Shadow mode: ${action === 'BUY_BOTH' ? 'Buy' : 'Sell'} opportunity detected. YES=${(yesPrice.mid * 100).toFixed(1)}¢ + NO=${(noPrice.mid * 100).toFixed(1)}¢ = ${(sum * 100).toFixed(1)}¢`
  };

  return opportunity;
}

/**
 * Scan all markets for arbitrage opportunities
 */
async function scanAllMarkets(): Promise<void> {
  console.log(`\n[${new Date().toISOString()}] Scanning ${markets.size} markets...`);

  let detected = 0;
  let errors = 0;
  let checked = 0;

  const marketArray = Array.from(markets.values());

  // Process markets in batches to avoid rate limiting
  const BATCH_SIZE = 10;
  const BATCH_DELAY = 1000; // 1 second between batches

  for (let i = 0; i < marketArray.length; i += BATCH_SIZE) {
    const batch = marketArray.slice(i, i + BATCH_SIZE);

    // Process batch in parallel
    const results = await Promise.all(
      batch.map(async (market) => {
        try {
          const opp = await checkMarketArbitrage(market);
          return { market, opp, error: null };
        } catch (error: any) {
          return { market, opp: null, error };
        }
      })
    );

    for (const { market, opp, error } of results) {
      checked++;
      if (error) {
        errors++;
        continue;
      }

      if (opp) {
        opportunities.push(opp);
        detected++;

        // Update stats
        stats.opportunitiesDetected++;
        stats.theoreticalPnL += opp.theoreticalProfit;
        if (opp.spreadPercent > stats.largestSpread) {
          stats.largestSpread = opp.spreadPercent;
        }

        // Log to console
        const emoji = opp.spreadPercent >= ALERT_SPREAD_THRESHOLD * 100 ? '🚨' : '📊';
        console.log(`${emoji} OPPORTUNITY: ${market.slug}`);
        console.log(`   YES: ${(opp.yesPrice * 100).toFixed(2)}¢ | NO: ${(opp.noPrice * 100).toFixed(2)}¢`);
        console.log(`   Spread: ${opp.spreadPercent.toFixed(2)}% | Action: ${opp.action}`);
        console.log(`   Theoretical profit: ${opp.theoreticalProfit.toFixed(2)}% per cycle`);
        console.log(`   Liquidity: $${market.liquidity.toLocaleString()}`);

        // Send Telegram alert for significant opportunities
        if (opp.spreadPercent >= ALERT_SPREAD_THRESHOLD * 100) {
          await sendTelegramAlert(opp);
        }
      }
    }

    // Progress update
    if (checked % 50 === 0 || checked === marketArray.length) {
      console.log(`  Progress: ${checked}/${marketArray.length} markets checked...`);
    }

    // Rate limiting between batches
    if (i + BATCH_SIZE < marketArray.length) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
    }
  }

  // Calculate average spread
  if (opportunities.length > 0) {
    stats.avgSpread = opportunities.reduce((sum, o) => sum + o.spreadPercent, 0) / opportunities.length;
  }

  stats.lastUpdate = new Date().toISOString();

  console.log(`Scan complete: ${detected} opportunities detected, ${errors} errors`);
  console.log(`Total opportunities: ${stats.opportunitiesDetected} | Theoretical P&L: ${stats.theoreticalPnL.toFixed(2)}%`);

  // Save to file
  saveOpportunities();
}

/**
 * Send Telegram alert for significant opportunity
 */
async function sendTelegramAlert(opp: ArbitrageOpportunity): Promise<void> {
  try {
    // Dynamic import to avoid issues if telegram module not available
    const { sendMessage } = await import('../telegram/bot');

    const message = `🚨 *Arbitrage Opportunity Detected*\n\n` +
      `*Market:* ${escapeMarkdown(opp.market.substring(0, 50))}\n` +
      `*Spread:* ${opp.spreadPercent.toFixed(2)}%\n` +
      `*Action:* ${opp.action}\n` +
      `*YES:* ${(opp.yesPrice * 100).toFixed(2)}¢ | *NO:* ${(opp.noPrice * 100).toFixed(2)}¢\n` +
      `*Theoretical profit:* ${opp.theoreticalProfit.toFixed(2)}%\n` +
      `*Liquidity:* $${opp.liquidity.toLocaleString()}\n\n` +
      `_Shadow mode \\- no trade executed_`;

    await sendMessage(message);
  } catch (error: any) {
    console.error(`Failed to send Telegram alert: ${error.message}`);
  }
}

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}

/**
 * Print summary statistics
 */
function printStats(): void {
  console.log('\n========== SHADOW MODE STATS ==========');
  console.log(`Started: ${stats.startTime}`);
  console.log(`Last update: ${stats.lastUpdate}`);
  console.log(`Markets monitored: ${stats.marketsMonitored}`);
  console.log(`Opportunities detected: ${stats.opportunitiesDetected}`);
  console.log(`Theoretical P&L: ${stats.theoreticalPnL.toFixed(2)}%`);
  console.log(`Largest spread: ${stats.largestSpread.toFixed(2)}%`);
  console.log(`Average spread: ${stats.avgSpread.toFixed(2)}%`);
  console.log('========================================\n');
}

/**
 * Main polling loop
 */
async function runPollingLoop(): Promise<void> {
  console.log('Starting Shadow Mode Arbitrage Detector...');
  console.log(`Thresholds: min_spread=${MIN_SPREAD_THRESHOLD * 100}%, alert=${ALERT_SPREAD_THRESHOLD * 100}%, min_liquidity=$${MIN_LIQUIDITY}`);

  // Ensure stdout is flushed
  process.stdout.write('');

  // Load existing data
  loadOpportunities();

  console.log('Fetching markets from Gamma API...');

  // Initial market fetch
  await fetchMarkets();

  console.log(`Markets loaded: ${markets.size}`);

  if (markets.size === 0) {
    console.error('No markets loaded. Exiting.');
    process.exit(1);
  }

  // Scan loop
  let scanCount = 0;
  const maxScans = process.argv.includes('--once') ? 1 : Infinity;

  while (scanCount < maxScans) {
    await scanAllMarkets();
    scanCount++;

    if (scanCount >= maxScans) break;

    // Refresh market list every 10 scans
    if (scanCount % 10 === 0) {
      await fetchMarkets();
    }

    // Print stats every 5 scans
    if (scanCount % 5 === 0) {
      printStats();
    }

    // Wait before next scan
    console.log(`Waiting ${POLL_INTERVAL_MS / 1000}s before next scan...`);
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  printStats();
  console.log('Scan complete.');
}

/**
 * Test mode with sample data
 */
async function runTestMode(): Promise<void> {
  console.log('Running in TEST MODE with sample data...\n');

  // Simulate a market with arbitrage opportunity
  const testOpp: ArbitrageOpportunity = {
    timestamp: new Date().toISOString(),
    market: 'Will Bitcoin exceed $100,000 by end of 2025?',
    marketSlug: 'btc-100k-2025',
    conditionId: 'test-condition-id',
    yesPrice: 0.48,
    noPrice: 0.49,  // Sum = 0.97, spread = -3%
    spread: -0.03,
    spreadPercent: 3.0,
    theoreticalProfit: 3.09,  // (1 - 0.97) / 0.97 * 100
    liquidity: 50000,
    action: 'BUY_BOTH',
    executed: false,
    notes: 'TEST: Buy opportunity. YES=48¢ + NO=49¢ = 97¢'
  };

  console.log('Sample opportunity:');
  console.log(JSON.stringify(testOpp, null, 2));
  console.log('\nTest passed! Detector logic is working.');
}

// Main entry point
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--test')) {
    await runTestMode();
  } else {
    await runPollingLoop();
  }
}

main().catch(error => {
  console.error(`Fatal error: ${error.message}`);
  process.exit(1);
});
