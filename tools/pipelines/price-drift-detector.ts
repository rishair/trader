/**
 * Price Drift Detector (imp-010)
 *
 * Monitors markets for sudden price movements (>5% in 1h).
 * When detected, generates a "follow signal" hypothesis.
 * The idea: sudden moves may indicate informed money.
 *
 * Usage: npx ts-node tools/pipelines/price-drift-detector.ts
 * Output: JSON to stdout with detected drifts and generated hypotheses
 */

import * as fs from 'fs';
import * as path from 'path';
import { sendAlert, alertSystem } from '../alerts/telegram-alerts';

const STATE_DIR = path.join(__dirname, '../../state');
const DRIFT_STATE_FILE = path.join(STATE_DIR, 'trading/drift-history.json');
const HYPOTHESES_FILE = path.join(STATE_DIR, 'trading/hypotheses.json');
const ENGINE_STATUS_FILE = path.join(STATE_DIR, 'trading/engine-status.json');

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';

// Configuration
const DRIFT_THRESHOLD = 0.05; // 5% price change triggers alert
const MIN_VOLUME_24H = 10000; // Minimum $10k volume to filter noise
const MAX_HYPOTHESES_PER_RUN = 3; // Don't flood with hypotheses
const LOOKBACK_HOURS = 1; // Time window for drift detection

interface MarketSnapshot {
  marketId: string;
  slug: string;
  question: string;
  tokenId: string;
  price: number;
  volume24h: number;
  liquidity: number;
  timestamp: string;
}

interface DriftSignal {
  marketId: string;
  slug: string;
  question: string;
  tokenId: string;
  previousPrice: number;
  currentPrice: number;
  priceChange: number;
  priceChangePct: number;
  direction: 'UP' | 'DOWN';
  volume24h: number;
  liquidity: number;
  timeSinceLastSnapshot: number; // minutes
  timestamp: string;
  signalStrength: 'moderate' | 'strong' | 'extreme';
}

interface DriftState {
  lastRun: string;
  snapshots: MarketSnapshot[];
  recentDrifts: DriftSignal[];
  generatedHypotheses: string[];
}

interface PipelineOutput {
  runAt: string;
  marketsScanned: number;
  driftsDetected: number;
  drifts: DriftSignal[];
  hypothesesGenerated: string[];
  alertsSent: number;
  errors: string[];
}

async function fetchActiveMarkets(): Promise<any[]> {
  try {
    // Get active markets with decent volume
    const response = await fetch(`${GAMMA_API}/markets?closed=false&limit=100`);
    if (!response.ok) {
      throw new Error(`Gamma API error: ${response.status}`);
    }

    const markets = await response.json() as any[];

    // Filter to markets with meaningful volume
    return markets.filter((m: any) => {
      const volume = m.volume24hr || 0;
      return volume >= MIN_VOLUME_24H;
    });
  } catch (error: any) {
    console.error(`Error fetching markets: ${error.message}`);
    return [];
  }
}

async function fetchPrice(tokenId: string): Promise<{ price: number; bid: number; ask: number } | null> {
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
    const mid = (bid + ask) / 2;

    return { price: mid || bid || ask, bid, ask };
  } catch {
    return null;
  }
}

function loadDriftState(): DriftState {
  try {
    return JSON.parse(fs.readFileSync(DRIFT_STATE_FILE, 'utf-8'));
  } catch {
    return {
      lastRun: new Date(0).toISOString(),
      snapshots: [],
      recentDrifts: [],
      generatedHypotheses: []
    };
  }
}

function saveDriftState(state: DriftState): void {
  fs.writeFileSync(DRIFT_STATE_FILE, JSON.stringify(state, null, 2));
}

function calculateSignalStrength(priceChangePct: number): 'moderate' | 'strong' | 'extreme' {
  const absPct = Math.abs(priceChangePct);
  if (absPct >= 0.15) return 'extreme';
  if (absPct >= 0.10) return 'strong';
  return 'moderate';
}

function detectDrift(
  current: MarketSnapshot,
  previous: MarketSnapshot | undefined
): DriftSignal | null {
  if (!previous) return null;

  const priceChange = current.price - previous.price;
  const priceChangePct = previous.price > 0 ? priceChange / previous.price : 0;

  // Check if drift exceeds threshold
  if (Math.abs(priceChangePct) < DRIFT_THRESHOLD) return null;

  const previousTime = new Date(previous.timestamp).getTime();
  const currentTime = new Date(current.timestamp).getTime();
  const timeSinceLastSnapshot = (currentTime - previousTime) / (1000 * 60);

  return {
    marketId: current.marketId,
    slug: current.slug,
    question: current.question,
    tokenId: current.tokenId,
    previousPrice: previous.price,
    currentPrice: current.price,
    priceChange,
    priceChangePct,
    direction: priceChange > 0 ? 'UP' : 'DOWN',
    volume24h: current.volume24h,
    liquidity: current.liquidity,
    timeSinceLastSnapshot,
    timestamp: current.timestamp,
    signalStrength: calculateSignalStrength(priceChangePct)
  };
}

function generateHypothesisFromDrift(drift: DriftSignal): any {
  const direction = drift.direction === 'UP' ? 'YES' : 'NO';
  const followDirection = drift.direction; // Follow the money

  // Calculate target based on momentum continuation
  const targetMove = Math.abs(drift.priceChangePct) * 0.5; // Expect 50% continuation
  const targetPrice = drift.direction === 'UP'
    ? Math.min(0.95, drift.currentPrice + targetMove)
    : Math.max(0.05, drift.currentPrice - targetMove);

  // Stop loss: reverse to previous price level
  const stopLoss = drift.direction === 'UP'
    ? Math.max(0.05, drift.previousPrice - 0.02)
    : Math.min(0.95, drift.previousPrice + 0.02);

  return {
    id: `hyp-drift-${Date.now()}`,
    statement: `Follow informed money: "${drift.slug}" drift signal suggests ${direction} continuation`,
    rationale: `Price moved ${(drift.priceChangePct * 100).toFixed(1)}% in ${drift.timeSinceLastSnapshot.toFixed(0)} minutes (${drift.signalStrength} signal). Volume $${(drift.volume24h / 1000).toFixed(0)}k. Hypothesis: someone knows something, follow the move.`,
    source: "platform",
    sourcePipeline: "price-drift-detector",
    testMethod: `Buy ${direction} at current price (~${(drift.currentPrice * 100).toFixed(0)}¢), target ${(targetPrice * 100).toFixed(0)}¢ or hold.`,
    entryRules: `Entry: ${(drift.currentPrice * 100).toFixed(0)}¢, Signal strength: ${drift.signalStrength}, Volume: $${(drift.volume24h / 1000).toFixed(0)}k`,
    exitRules: `Target: ${(targetPrice * 100).toFixed(0)}¢, Stop: ${(stopLoss * 100).toFixed(0)}¢`,
    expectedWinRate: 0.55,
    expectedPayoff: 1.4,
    minSampleSize: 10,
    status: "proposed",
    confidence: drift.signalStrength === 'extreme' ? 0.50 : drift.signalStrength === 'strong' ? 0.40 : 0.35,
    evidence: [{
      type: 'signal',
      description: `Drift detected: ${(drift.priceChangePct * 100).toFixed(1)}% ${drift.direction} in ${drift.timeSinceLastSnapshot.toFixed(0)}min`,
      impact: drift.signalStrength === 'extreme' ? 'strong_for' : 'moderate_for',
      addedAt: new Date().toISOString()
    }],
    conclusion: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    linkedMarket: {
      slug: drift.slug,
      question: drift.question,
      tokenId: drift.tokenId
    },
    driftData: {
      previousPrice: drift.previousPrice,
      currentPrice: drift.currentPrice,
      priceChangePct: drift.priceChangePct,
      signalStrength: drift.signalStrength,
      detectedAt: drift.timestamp
    }
  };
}

async function sendDriftAlert(drift: DriftSignal): Promise<boolean> {
  const emoji = drift.signalStrength === 'extreme' ? '🚨' : drift.signalStrength === 'strong' ? '⚡' : '📊';
  const dirEmoji = drift.direction === 'UP' ? '📈' : '📉';

  const message = `${emoji} *Price Drift Detected* ${dirEmoji}

*Market:* ${drift.slug}
*Question:* ${drift.question.slice(0, 80)}${drift.question.length > 80 ? '...' : ''}

*Signal:* ${drift.signalStrength.toUpperCase()}
*Move:* ${(drift.previousPrice * 100).toFixed(1)}¢ → ${(drift.currentPrice * 100).toFixed(1)}¢ (${drift.priceChangePct >= 0 ? '+' : ''}${(drift.priceChangePct * 100).toFixed(1)}%)
*Time:* ${drift.timeSinceLastSnapshot.toFixed(0)} minutes
*Volume 24h:* $${(drift.volume24h / 1000).toFixed(0)}k

_Informed money signal - consider following the move_`;

  return sendAlert({
    type: 'system_alert',
    severity: drift.signalStrength === 'extreme' ? 'warning' : 'info',
    title: `Price Drift: ${drift.slug}`,
    message
  });
}

async function runPipeline(): Promise<PipelineOutput> {
  const output: PipelineOutput = {
    runAt: new Date().toISOString(),
    marketsScanned: 0,
    driftsDetected: 0,
    drifts: [],
    hypothesesGenerated: [],
    alertsSent: 0,
    errors: []
  };

  console.error('Starting price-drift-detector pipeline...');

  // Load previous state
  const state = loadDriftState();
  const previousSnapshots = new Map<string, MarketSnapshot>();
  for (const snap of state.snapshots) {
    previousSnapshots.set(snap.marketId, snap);
  }

  // Fetch active markets
  const markets = await fetchActiveMarkets();
  output.marketsScanned = markets.length;
  console.error(`Scanning ${markets.length} active markets with >$${MIN_VOLUME_24H / 1000}k volume`);

  if (markets.length === 0) {
    output.errors.push('No active markets found');
    return output;
  }

  // Current snapshots
  const currentSnapshots: MarketSnapshot[] = [];
  const drifts: DriftSignal[] = [];

  // Check each market
  for (const market of markets) {
    try {
      // Parse clobTokenIds - may be a JSON string or array
      let tokenIds: string[] = [];
      if (typeof market.clobTokenIds === 'string') {
        try {
          tokenIds = JSON.parse(market.clobTokenIds);
        } catch {
          continue;
        }
      } else if (Array.isArray(market.clobTokenIds)) {
        tokenIds = market.clobTokenIds;
      }

      const tokenId = tokenIds[0];
      if (!tokenId) continue;

      const priceData = await fetchPrice(tokenId);
      if (!priceData || priceData.price === 0) continue;

      const snapshot: MarketSnapshot = {
        marketId: market.id,
        slug: market.slug || market.id,
        question: market.question || 'Unknown',
        tokenId,
        price: priceData.price,
        volume24h: market.volume24hr || 0,
        liquidity: market.liquidity || 0,
        timestamp: new Date().toISOString()
      };

      currentSnapshots.push(snapshot);

      // Check for drift against previous snapshot
      const previous = previousSnapshots.get(market.id);
      const drift = detectDrift(snapshot, previous);

      if (drift) {
        drifts.push(drift);
        console.error(`Drift detected: ${drift.slug} ${(drift.priceChangePct * 100).toFixed(1)}% (${drift.signalStrength})`);
      }
    } catch (error: any) {
      output.errors.push(`Error processing ${market.slug}: ${error.message}`);
    }
  }

  output.drifts = drifts;
  output.driftsDetected = drifts.length;
  console.error(`Found ${drifts.length} drift signals`);

  // Sort drifts by signal strength and magnitude
  const sortedDrifts = drifts.sort((a, b) => {
    const strengthOrder = { extreme: 3, strong: 2, moderate: 1 };
    const strengthDiff = strengthOrder[b.signalStrength] - strengthOrder[a.signalStrength];
    if (strengthDiff !== 0) return strengthDiff;
    return Math.abs(b.priceChangePct) - Math.abs(a.priceChangePct);
  });

  // Generate hypotheses for top signals
  if (sortedDrifts.length > 0) {
    let hypotheses: any = { hypotheses: [] };
    try {
      hypotheses = JSON.parse(fs.readFileSync(HYPOTHESES_FILE, 'utf-8'));
    } catch {}

    // Only generate for strong/extreme signals, max 3 per run
    const topDrifts = sortedDrifts
      .filter(d => d.signalStrength !== 'moderate')
      .slice(0, MAX_HYPOTHESES_PER_RUN);

    for (const drift of topDrifts) {
      // Check if we already have a hypothesis for this market
      const existingHyp = hypotheses.hypotheses.find(
        (h: any) => h.linkedMarket?.slug === drift.slug &&
                    h.status !== 'invalidated' &&
                    h.sourcePipeline === 'price-drift-detector'
      );

      if (existingHyp) {
        console.error(`Skipping ${drift.slug} - existing hypothesis ${existingHyp.id}`);
        continue;
      }

      const newHyp = generateHypothesisFromDrift(drift);
      hypotheses.hypotheses.push(newHyp);
      output.hypothesesGenerated.push(newHyp.id);
      console.error(`Generated hypothesis: ${newHyp.id} for ${drift.slug}`);
    }

    // Save updated hypotheses
    fs.writeFileSync(HYPOTHESES_FILE, JSON.stringify(hypotheses, null, 2));
  }

  // Send alerts for significant drifts
  for (const drift of sortedDrifts.filter(d => d.signalStrength !== 'moderate')) {
    try {
      const sent = await sendDriftAlert(drift);
      if (sent) output.alertsSent++;
    } catch (error: any) {
      output.errors.push(`Failed to send alert for ${drift.slug}: ${error.message}`);
    }
  }

  // Update drift state
  state.lastRun = output.runAt;
  state.snapshots = currentSnapshots;

  // Keep last 24h of drifts
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  state.recentDrifts = [
    ...drifts,
    ...state.recentDrifts.filter(d => d.timestamp > oneDayAgo)
  ].slice(0, 100); // Max 100 recent drifts

  state.generatedHypotheses = [
    ...output.hypothesesGenerated,
    ...state.generatedHypotheses
  ].slice(0, 50); // Keep last 50 generated hypotheses

  saveDriftState(state);

  // Update engine status metrics
  try {
    const engineStatus = JSON.parse(fs.readFileSync(ENGINE_STATUS_FILE, 'utf-8'));
    engineStatus.lastEvaluated = new Date().toISOString();
    engineStatus.metrics.hypothesesGeneratedThisWeek += output.hypothesesGenerated.length;

    // Add drift tracking to metrics if not present
    if (!engineStatus.metrics.driftSignalsToday) {
      engineStatus.metrics.driftSignalsToday = 0;
    }
    engineStatus.metrics.driftSignalsToday += output.driftsDetected;

    fs.writeFileSync(ENGINE_STATUS_FILE, JSON.stringify(engineStatus, null, 2));
  } catch (error: any) {
    output.errors.push(`Failed to update engine status: ${error.message}`);
  }

  return output;
}

// CLI interface
if (require.main === module) {
  runPipeline()
    .then(output => {
      console.log(JSON.stringify(output, null, 2));
      process.exit(output.errors.length > 0 && output.driftsDetected === 0 ? 1 : 0);
    })
    .catch(error => {
      console.error(`Pipeline failed: ${error.message}`);
      process.exit(1);
    });
}

export { runPipeline };
export type { DriftSignal, MarketSnapshot };
