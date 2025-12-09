/**
 * Price Tracker (imp-003)
 *
 * Fetches current prices for all open positions and updates portfolio.json.
 * Can also be used to fetch individual market prices.
 * Sends Telegram alerts for significant price movements and exit triggers.
 *
 * Usage:
 *   npx ts-node tools/pipelines/price-tracker.ts              # Update all positions
 *   npx ts-node tools/pipelines/price-tracker.ts <tokenId>    # Fetch single price
 */

import * as fs from 'fs';
import * as path from 'path';
import { alertExitTrigger, alertPriceMovement } from '../alerts/telegram-alerts';
import { exitPosition } from '../../lib/trading';

const STATE_DIR = path.join(__dirname, '../../state');
const PORTFOLIO_FILE = path.join(STATE_DIR, 'portfolio.json');
const PRICE_HISTORY_FILE = path.join(STATE_DIR, 'price-history.json');

const POLYMARKET_CLOB_API = 'https://clob.polymarket.com';

interface Position {
  id: string;
  market: string;
  marketSlug: string;
  platform: string;
  direction: string;
  outcome: string;
  entryPrice: number;
  shares: number;
  cost: number;
  currentPrice: number;
  unrealizedPnL: number;
  tokenId?: string;
  strategyId: string;
  entryDate: string;
  exitCriteria: {
    takeProfit: number;
    stopLoss: number;
    timeLimit: string;
    notes: string;
  };
  rationale: string;
}

interface Portfolio {
  cash: number;
  startingCapital: number;
  positions: Position[];
  tradeHistory: any[];
  createdAt: string;
  lastUpdated: string;
  metrics: {
    totalReturn: number;
    totalReturnPct: number;
    realizedPnL: number;
    unrealizedPnL: number;
    winCount: number;
    lossCount: number;
    winRate: number;
  };
}

interface PriceSnapshot {
  timestamp: string;
  prices: {
    [tokenId: string]: {
      market: string;
      outcome: string;
      price: number;
      bid?: number;
      ask?: number;
    };
  };
}

// Known token IDs for our positions
const KNOWN_TOKENS: { [key: string]: { market: string; outcome: string; tokenId: string } } = {
  'largest-company-end-of-2025:Apple': {
    market: 'Largest Company end of 2025',
    outcome: 'Apple',
    tokenId: '64608332692655386624219169603174714750740291631647562666654835455208498486268'
  },
  'largest-company-end-of-2025:NVIDIA': {
    market: 'Largest Company end of 2025',
    outcome: 'NVIDIA',
    tokenId: '94850533403292240972948844256810904078895883844462287088135166537739765648754'
  }
};

async function fetchPrice(tokenId: string): Promise<{ price: number; bid: number; ask: number } | null> {
  try {
    // Fetch both buy and sell prices for better accuracy
    const [buyRes, sellRes] = await Promise.all([
      fetch(`${POLYMARKET_CLOB_API}/price?token_id=${tokenId}&side=buy`),
      fetch(`${POLYMARKET_CLOB_API}/price?token_id=${tokenId}&side=sell`)
    ]);

    if (!buyRes.ok || !sellRes.ok) {
      console.error(`API error: buy=${buyRes.status}, sell=${sellRes.status}`);
      return null;
    }

    const buyData = await buyRes.json() as any;
    const sellData = await sellRes.json() as any;

    const bid = parseFloat(buyData.price) || 0;
    const ask = parseFloat(sellData.price) || 0;
    const mid = (bid + ask) / 2;

    return { price: mid || bid || ask, bid, ask };
  } catch (error: any) {
    console.error(`Error fetching price for ${tokenId}: ${error.message}`);
    return null;
  }
}

async function updatePortfolioPrices(): Promise<{
  updated: boolean;
  positions: { id: string; oldPrice: number; newPrice: number; pnlChange: number }[];
  errors: string[];
}> {
  const result = {
    updated: false,
    positions: [] as { id: string; oldPrice: number; newPrice: number; pnlChange: number }[],
    errors: [] as string[]
  };

  // Load portfolio
  let portfolio: Portfolio;
  try {
    portfolio = JSON.parse(fs.readFileSync(PORTFOLIO_FILE, 'utf-8'));
  } catch (error: any) {
    result.errors.push(`Failed to load portfolio: ${error.message}`);
    return result;
  }

  if (portfolio.positions.length === 0) {
    console.log('No positions to update');
    return result;
  }

  // Update each position
  for (const position of portfolio.positions) {
    const key = `${position.marketSlug}:${position.outcome}`;
    const tokenInfo = KNOWN_TOKENS[key];

    if (!tokenInfo) {
      result.errors.push(`No token ID found for ${key}`);
      continue;
    }

    const priceData = await fetchPrice(tokenInfo.tokenId);
    if (!priceData) {
      result.errors.push(`Failed to fetch price for ${position.outcome}`);
      continue;
    }

    const oldPrice = position.currentPrice;
    const newPrice = priceData.price;
    const oldPnL = position.unrealizedPnL;

    // Calculate new P&L
    // If we own YES shares, profit = (currentPrice - entryPrice) * shares
    const newPnL = (newPrice - position.entryPrice) * position.shares;

    // Update position
    position.currentPrice = newPrice;
    position.unrealizedPnL = newPnL;
    position.tokenId = tokenInfo.tokenId;

    result.positions.push({
      id: position.id,
      oldPrice,
      newPrice,
      pnlChange: newPnL - oldPnL
    });

    result.updated = true;
  }

  // Update portfolio metrics
  const totalUnrealizedPnL = portfolio.positions.reduce((sum, p) => sum + p.unrealizedPnL, 0);
  const totalValue = portfolio.cash + portfolio.positions.reduce(
    (sum, p) => sum + (p.currentPrice * p.shares), 0
  );

  portfolio.metrics.unrealizedPnL = totalUnrealizedPnL;
  portfolio.metrics.totalReturn = totalValue - portfolio.startingCapital;
  portfolio.metrics.totalReturnPct = ((totalValue - portfolio.startingCapital) / portfolio.startingCapital) * 100;
  portfolio.lastUpdated = new Date().toISOString();

  // Save portfolio
  fs.writeFileSync(PORTFOLIO_FILE, JSON.stringify(portfolio, null, 2));

  // Save price snapshot to history
  savePriceSnapshot(portfolio.positions);

  return result;
}

function savePriceSnapshot(positions: Position[]) {
  let history: PriceSnapshot[] = [];
  try {
    history = JSON.parse(fs.readFileSync(PRICE_HISTORY_FILE, 'utf-8'));
  } catch {
    // File doesn't exist yet
  }

  const snapshot: PriceSnapshot = {
    timestamp: new Date().toISOString(),
    prices: {}
  };

  for (const pos of positions) {
    if (pos.tokenId) {
      snapshot.prices[pos.tokenId] = {
        market: pos.market,
        outcome: pos.outcome,
        price: pos.currentPrice
      };
    }
  }

  history.push(snapshot);

  // Keep last 30 days of hourly data (~720 snapshots)
  if (history.length > 720) {
    history = history.slice(-720);
  }

  fs.writeFileSync(PRICE_HISTORY_FILE, JSON.stringify(history, null, 2));
}

function checkExitTriggers(portfolio: Portfolio): {
  position: string;
  trigger: 'take_profit' | 'stop_loss' | 'time_limit';
  currentPrice: number;
  threshold: number;
}[] {
  const triggers = [];

  for (const pos of portfolio.positions) {
    if (pos.currentPrice >= pos.exitCriteria.takeProfit) {
      triggers.push({
        position: pos.id,
        trigger: 'take_profit' as const,
        currentPrice: pos.currentPrice,
        threshold: pos.exitCriteria.takeProfit
      });
    }

    if (pos.currentPrice <= pos.exitCriteria.stopLoss) {
      triggers.push({
        position: pos.id,
        trigger: 'stop_loss' as const,
        currentPrice: pos.currentPrice,
        threshold: pos.exitCriteria.stopLoss
      });
    }

    const timeLimit = new Date(pos.exitCriteria.timeLimit);
    if (new Date() >= timeLimit) {
      triggers.push({
        position: pos.id,
        trigger: 'time_limit' as const,
        currentPrice: pos.currentPrice,
        threshold: 0
      });
    }
  }

  return triggers;
}

// Thresholds for alerts
const PRICE_CHANGE_ALERT_THRESHOLD = 0.10; // 10% price change triggers alert
const PNL_CHANGE_ALERT_THRESHOLD = 50; // $50 P&L change triggers alert

async function main() {
  const args = process.argv.slice(2);

  if (args.length > 0) {
    // Fetch single token price
    const tokenId = args[0];
    console.log(`Fetching price for token: ${tokenId}`);
    const price = await fetchPrice(tokenId);
    console.log(JSON.stringify(price, null, 2));
    return;
  }

  // Update all positions
  console.log('Updating portfolio prices...');
  const result = await updatePortfolioPrices();

  if (result.errors.length > 0) {
    console.error('Errors:', result.errors);
  }

  if (result.updated) {
    console.log('\nPrice updates:');
    const portfolio = JSON.parse(fs.readFileSync(PORTFOLIO_FILE, 'utf-8'));

    for (const pos of result.positions) {
      const pnlSign = pos.pnlChange >= 0 ? '+' : '';
      console.log(`  ${pos.id}: ${(pos.oldPrice * 100).toFixed(1)}¢ → ${(pos.newPrice * 100).toFixed(1)}¢ (${pnlSign}$${pos.pnlChange.toFixed(2)})`);

      // Send price alert if significant movement
      const changePercent = Math.abs((pos.newPrice - pos.oldPrice) / pos.oldPrice);
      if (changePercent >= PRICE_CHANGE_ALERT_THRESHOLD || Math.abs(pos.pnlChange) >= PNL_CHANGE_ALERT_THRESHOLD) {
        const position = portfolio.positions.find((p: Position) => p.id === pos.id);
        if (position) {
          console.log(`  → Sending price alert for ${pos.id}`);
          await alertPriceMovement(
            position.market,
            position.outcome,
            pos.oldPrice,
            pos.newPrice,
            pos.pnlChange,
            pos.id
          );
        }
      }
    }

    // Check exit triggers and AUTO-EXECUTE
    const triggers = checkExitTriggers(portfolio);

    if (triggers.length > 0) {
      console.log('\n⚠️  EXIT TRIGGERS - AUTO-EXECUTING:');
      for (const t of triggers) {
        console.log(`  ${t.position}: ${t.trigger} at ${(t.currentPrice * 100).toFixed(1)}¢ (threshold: ${(t.threshold * 100).toFixed(1)}¢)`);

        const position = portfolio.positions.find((p: Position) => p.id === t.position);
        if (position) {
          // AUTO-EXECUTE the exit
          const triggerName = t.trigger === 'take_profit' ? 'Take profit' :
                              t.trigger === 'stop_loss' ? 'Stop loss' : 'Time limit';
          const reason = `${triggerName} triggered at ${(t.currentPrice * 100).toFixed(1)}¢`;

          console.log(`  → AUTO-EXECUTING exit for ${t.position}: ${reason}`);
          try {
            const result = await exitPosition(t.position, t.currentPrice, reason);
            if (result.success) {
              console.log(`  ✅ Exit executed successfully for ${t.position}`);
            } else {
              console.error(`  ❌ Exit failed for ${t.position}: ${result.error}`);
              // Still send alert if auto-exit fails
              await alertExitTrigger(
                t.trigger,
                t.position,
                position.market,
                position.outcome,
                t.currentPrice,
                t.threshold,
                position.unrealizedPnL
              );
            }
          } catch (error: any) {
            console.error(`  ❌ Exit error for ${t.position}: ${error.message}`);
            // Send alert on error so user is aware
            await alertExitTrigger(
              t.trigger,
              t.position,
              position.market,
              position.outcome,
              t.currentPrice,
              t.threshold,
              position.unrealizedPnL
            );
          }
        }
      }

      // Reload portfolio after exits
      const updatedPortfolio = JSON.parse(fs.readFileSync(PORTFOLIO_FILE, 'utf-8'));
      portfolio = updatedPortfolio;
    }

    // Print summary
    console.log('\nPortfolio Summary:');
    console.log(`  Cash: $${portfolio.cash.toFixed(2)}`);
    console.log(`  Positions Value: $${portfolio.positions.reduce((s: number, p: Position) => s + p.currentPrice * p.shares, 0).toFixed(2)}`);
    console.log(`  Unrealized P&L: $${portfolio.metrics.unrealizedPnL.toFixed(2)}`);
    console.log(`  Total Return: ${portfolio.metrics.totalReturnPct.toFixed(2)}%`);
  } else {
    console.log('No positions updated');
  }

  // Output JSON for programmatic use
  console.log('\n---JSON---');
  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => {
  console.error(`Failed: ${error.message}`);
  process.exit(1);
});
