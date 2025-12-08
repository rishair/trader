/**
 * Leaderboard Tracker Pipeline (imp-009)
 *
 * Daily scrape of top traders, track their positions, generate follow signals.
 * Copy smart money strategy - find what the best traders are doing.
 *
 * Usage: npx ts-node tools/pipelines/leaderboard-tracker.ts
 * Output: JSON to stdout with top traders and their positions
 */

import * as fs from 'fs';
import * as path from 'path';

const STATE_DIR = path.join(__dirname, '../../state');
const LEADERBOARD_DIR = path.join(STATE_DIR, 'leaderboard');
const HYPOTHESES_FILE = path.join(STATE_DIR, 'hypotheses.json');
const ENGINE_STATUS_FILE = path.join(STATE_DIR, 'engine-status.json');

// APIs
const LB_API = 'https://lb-api.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com';

interface Trader {
  proxyWallet: string;
  name: string;
  pseudonym: string;
  profit: number;
  profitRank: number;
  volume?: number;
  volumeRank?: number;
  bio?: string;
  profileImage?: string;
}

interface Position {
  asset: string;
  conditionId: string;
  title: string;
  slug: string;
  outcome: string;
  size: number;
  avgPrice: number;
  currentValue: number;
  curPrice: number;
  cashPnl: number;
  percentPnl: number;
  endDate: string;
}

interface TraderSnapshot {
  trader: Trader;
  positions: Position[];
  snapshotAt: string;
}

interface LeaderboardSnapshot {
  runAt: string;
  window: string;
  topByProfit: Trader[];
  topByVolume: Trader[];
  newEntries: string[];  // wallets new to top 20
  droppedOut: string[];  // wallets that dropped from top 20
}

interface PipelineOutput {
  runAt: string;
  leaderboard: LeaderboardSnapshot;
  traderSnapshots: TraderSnapshot[];
  followSignals: FollowSignal[];
  hypothesesGenerated: string[];
  errors: string[];
}

interface FollowSignal {
  type: 'new_position' | 'increased_position' | 'consensus';
  trader: string;
  traderRank: number;
  market: string;
  slug: string;
  outcome: string;
  size: number;
  price: number;
  confidence: number;
  reason: string;
}

// Ensure leaderboard directory exists
function ensureLeaderboardDir() {
  if (!fs.existsSync(LEADERBOARD_DIR)) {
    fs.mkdirSync(LEADERBOARD_DIR, { recursive: true });
  }
}

async function fetchLeaderboard(metric: 'profit' | 'volume', window?: string): Promise<Trader[]> {
  try {
    const url = window
      ? `${LB_API}/${metric}?window=${window}`
      : `${LB_API}/${metric}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`LB API error: ${response.status}`);
    }

    const data = await response.json() as any[];
    return data.slice(0, 50).map((t, idx) => ({
      proxyWallet: t.proxyWallet,
      name: t.name || t.pseudonym,
      pseudonym: t.pseudonym,
      profit: metric === 'profit' ? t.amount : 0,
      profitRank: metric === 'profit' ? idx + 1 : 0,
      volume: metric === 'volume' ? t.amount : undefined,
      volumeRank: metric === 'volume' ? idx + 1 : undefined,
      bio: t.bio,
      profileImage: t.profileImage
    }));
  } catch (error: any) {
    console.error(`Error fetching ${metric} leaderboard: ${error.message}`);
    return [];
  }
}

async function fetchTraderPositions(wallet: string): Promise<Position[]> {
  try {
    const response = await fetch(
      `${DATA_API}/positions?user=${wallet}&sizeThreshold=0`
    );
    if (!response.ok) return [];

    const data = await response.json() as any[];
    return data
      .filter((p: any) => p.size > 0)  // Active positions only
      .map((p: any) => ({
        asset: p.asset,
        conditionId: p.conditionId,
        title: p.title,
        slug: p.slug,
        outcome: p.outcome,
        size: p.size,
        avgPrice: p.avgPrice,
        currentValue: p.currentValue,
        curPrice: p.curPrice,
        cashPnl: p.cashPnl,
        percentPnl: p.percentPnl,
        endDate: p.endDate
      }));
  } catch (error: any) {
    console.error(`Error fetching positions for ${wallet}: ${error.message}`);
    return [];
  }
}

function loadPreviousSnapshot(): LeaderboardSnapshot | null {
  const snapshotFile = path.join(LEADERBOARD_DIR, 'latest.json');
  try {
    if (fs.existsSync(snapshotFile)) {
      return JSON.parse(fs.readFileSync(snapshotFile, 'utf-8'));
    }
  } catch {}
  return null;
}

function saveSnapshot(snapshot: LeaderboardSnapshot, traderSnapshots: TraderSnapshot[]) {
  ensureLeaderboardDir();

  // Save latest
  fs.writeFileSync(
    path.join(LEADERBOARD_DIR, 'latest.json'),
    JSON.stringify(snapshot, null, 2)
  );

  // Save timestamped copy
  const date = new Date().toISOString().split('T')[0];
  fs.writeFileSync(
    path.join(LEADERBOARD_DIR, `snapshot-${date}.json`),
    JSON.stringify({ leaderboard: snapshot, traders: traderSnapshots }, null, 2)
  );

  // Update trader history files
  for (const ts of traderSnapshots) {
    const traderFile = path.join(LEADERBOARD_DIR, `trader-${ts.trader.pseudonym}.json`);
    let history: TraderSnapshot[] = [];
    try {
      if (fs.existsSync(traderFile)) {
        history = JSON.parse(fs.readFileSync(traderFile, 'utf-8'));
      }
    } catch {}
    history.push(ts);
    // Keep last 30 snapshots
    if (history.length > 30) history = history.slice(-30);
    fs.writeFileSync(traderFile, JSON.stringify(history, null, 2));
  }
}

function detectFollowSignals(
  currentTraders: TraderSnapshot[],
  previousSnapshot: LeaderboardSnapshot | null
): FollowSignal[] {
  const signals: FollowSignal[] = [];

  // Aggregate positions across top traders
  const positionCounts = new Map<string, {
    market: string;
    slug: string;
    outcome: string;
    traders: { name: string; rank: number; size: number; price: number }[];
  }>();

  for (const ts of currentTraders) {
    for (const pos of ts.positions) {
      const key = `${pos.slug}-${pos.outcome}`;
      if (!positionCounts.has(key)) {
        positionCounts.set(key, {
          market: pos.title,
          slug: pos.slug,
          outcome: pos.outcome,
          traders: []
        });
      }
      positionCounts.get(key)!.traders.push({
        name: ts.trader.pseudonym,
        rank: ts.trader.profitRank,
        size: pos.size,
        price: pos.curPrice
      });
    }
  }

  // Find consensus positions (3+ top traders holding same position)
  for (const [key, data] of positionCounts) {
    if (data.traders.length >= 3) {
      const avgRank = data.traders.reduce((s, t) => s + t.rank, 0) / data.traders.length;
      const totalSize = data.traders.reduce((s, t) => s + t.size, 0);
      const avgPrice = data.traders.reduce((s, t) => s + t.price, 0) / data.traders.length;

      signals.push({
        type: 'consensus',
        trader: data.traders.map(t => t.name).join(', '),
        traderRank: Math.round(avgRank),
        market: data.market,
        slug: data.slug,
        outcome: data.outcome,
        size: totalSize,
        price: avgPrice,
        confidence: Math.min(0.7, 0.4 + data.traders.length * 0.1),
        reason: `${data.traders.length} top traders (avg rank ${avgRank.toFixed(0)}) hold ${data.outcome} positions`
      });
    }
  }

  // Sort by confidence
  signals.sort((a, b) => b.confidence - a.confidence);

  return signals.slice(0, 10);  // Top 10 signals
}

function generateHypothesisFromSignal(signal: FollowSignal): any {
  return {
    id: `hyp-lb-${Date.now()}`,
    statement: `Following top traders' ${signal.outcome} position on "${signal.market}" will be profitable`,
    rationale: signal.reason,
    source: "leaderboard",
    sourcePipeline: "leaderboard-tracker",
    testMethod: `Buy ${signal.outcome} at current price (~${(signal.price * 100).toFixed(0)}¢). Hold to resolution or until top traders exit.`,
    entryRules: `Multiple top traders (${signal.type === 'consensus' ? 'consensus' : 'single'}) hold ${signal.outcome}`,
    exitRules: `Resolution, or top traders exit position, or 15% adverse move`,
    expectedWinRate: 0.55,
    expectedPayoff: 1.5,
    minSampleSize: 5,
    status: "proposed",
    confidence: signal.confidence,
    evidence: [{
      date: new Date().toISOString().split('T')[0],
      observation: signal.reason,
      supports: true,
      confidenceImpact: 0
    }],
    conclusion: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    linkedSignal: {
      type: signal.type,
      market: signal.market,
      slug: signal.slug,
      outcome: signal.outcome,
      traders: signal.trader
    }
  };
}

async function runPipeline(): Promise<PipelineOutput> {
  const output: PipelineOutput = {
    runAt: new Date().toISOString(),
    leaderboard: {
      runAt: new Date().toISOString(),
      window: 'all-time',
      topByProfit: [],
      topByVolume: [],
      newEntries: [],
      droppedOut: []
    },
    traderSnapshots: [],
    followSignals: [],
    hypothesesGenerated: [],
    errors: []
  };

  console.error('Starting leaderboard-tracker pipeline...');

  // Fetch leaderboards - all-time for tracking, weekly for active positions
  const [profitLeaders, volumeLeaders, weeklyProfitLeaders] = await Promise.all([
    fetchLeaderboard('profit'),
    fetchLeaderboard('volume'),
    fetchLeaderboard('profit', '1w')  // Weekly winners more likely to have active positions
  ]);

  if (profitLeaders.length === 0) {
    output.errors.push('Failed to fetch profit leaderboard');
    return output;
  }

  output.leaderboard.topByProfit = profitLeaders.slice(0, 20);
  output.leaderboard.topByVolume = volumeLeaders.slice(0, 20);

  console.error(`Fetched ${profitLeaders.length} all-time profit leaders, ${weeklyProfitLeaders.length} weekly leaders`);

  // Load previous snapshot to detect changes
  const previous = loadPreviousSnapshot();
  if (previous) {
    const prevWallets = new Set(previous.topByProfit.map(t => t.proxyWallet));
    const currWallets = new Set(output.leaderboard.topByProfit.map(t => t.proxyWallet));

    output.leaderboard.newEntries = [...currWallets].filter(w => !prevWallets.has(w));
    output.leaderboard.droppedOut = [...prevWallets].filter(w => !currWallets.has(w));

    if (output.leaderboard.newEntries.length > 0) {
      console.error(`New entries to top 20: ${output.leaderboard.newEntries.length}`);
    }
  }

  // Prioritize weekly leaders (active traders) over all-time leaders (many inactive)
  // Combine top 5 weekly + top 5 all-time (deduplicated)
  const weeklyWallets = new Set(weeklyProfitLeaders.slice(0, 5).map(t => t.proxyWallet));
  const tradersToTrack = [
    ...weeklyProfitLeaders.slice(0, 5),
    ...profitLeaders.slice(0, 10).filter(t => !weeklyWallets.has(t.proxyWallet)).slice(0, 5)
  ];

  console.error(`Fetching positions for ${tradersToTrack.length} traders (${Math.min(5, weeklyProfitLeaders.length)} weekly + all-time)...`);
  const top10 = tradersToTrack;

  for (const trader of top10) {
    try {
      const positions = await fetchTraderPositions(trader.proxyWallet);
      output.traderSnapshots.push({
        trader,
        positions,
        snapshotAt: new Date().toISOString()
      });
      console.error(`  ${trader.pseudonym}: ${positions.length} positions`);

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 200));
    } catch (error: any) {
      output.errors.push(`Failed to fetch positions for ${trader.pseudonym}: ${error.message}`);
    }
  }

  // Detect follow signals
  output.followSignals = detectFollowSignals(output.traderSnapshots, previous);
  console.error(`Generated ${output.followSignals.length} follow signals`);

  // Generate hypotheses for strong consensus signals
  const strongSignals = output.followSignals.filter(
    s => s.type === 'consensus' && s.confidence >= 0.5
  );

  if (strongSignals.length > 0) {
    // Load existing hypotheses
    let hypotheses: any = { hypotheses: [], pipelineStats: {} };
    try {
      hypotheses = JSON.parse(fs.readFileSync(HYPOTHESES_FILE, 'utf-8'));
    } catch {}

    // Check for duplicate hypotheses (same market/outcome)
    const existingSlugs = new Set(
      hypotheses.hypotheses
        .filter((h: any) => h.source === 'leaderboard')
        .map((h: any) => h.linkedSignal?.slug + '-' + h.linkedSignal?.outcome)
    );

    for (const signal of strongSignals.slice(0, 2)) {  // Max 2 new hypotheses per run
      const key = signal.slug + '-' + signal.outcome;
      if (existingSlugs.has(key)) {
        console.error(`  Skipping duplicate hypothesis for ${signal.slug}`);
        continue;
      }

      const newHyp = generateHypothesisFromSignal(signal);
      hypotheses.hypotheses.push(newHyp);
      output.hypothesesGenerated.push(newHyp.id);
      console.error(`Generated hypothesis: ${newHyp.id} for ${signal.slug} (${signal.outcome})`);
    }

    // Update pipeline stats
    if (!hypotheses.pipelineStats.leaderboard) {
      hypotheses.pipelineStats.leaderboard = { generated: 0, validated: 0, invalidated: 0 };
    }
    hypotheses.pipelineStats.leaderboard.generated += output.hypothesesGenerated.length;

    // Save updated hypotheses
    fs.writeFileSync(HYPOTHESES_FILE, JSON.stringify(hypotheses, null, 2));
  }

  // Save leaderboard snapshot
  saveSnapshot(output.leaderboard, output.traderSnapshots);

  // Update engine status
  try {
    let engineStatus: any = {};
    if (fs.existsSync(ENGINE_STATUS_FILE)) {
      engineStatus = JSON.parse(fs.readFileSync(ENGINE_STATUS_FILE, 'utf-8'));
    }
    engineStatus.lastLeaderboardScan = new Date().toISOString();
    engineStatus.topTraderCount = output.traderSnapshots.length;
    engineStatus.followSignalsGenerated = output.followSignals.length;

    if (!engineStatus.metrics) engineStatus.metrics = {};
    engineStatus.metrics.hypothesesGeneratedThisWeek =
      (engineStatus.metrics.hypothesesGeneratedThisWeek || 0) + output.hypothesesGenerated.length;

    fs.writeFileSync(ENGINE_STATUS_FILE, JSON.stringify(engineStatus, null, 2));
  } catch (error: any) {
    output.errors.push(`Failed to update engine status: ${error.message}`);
  }

  return output;
}

// Run the pipeline
runPipeline()
  .then(output => {
    // Summary output
    const summary = {
      runAt: output.runAt,
      tradersTracked: output.traderSnapshots.length,
      totalPositions: output.traderSnapshots.reduce((s, t) => s + t.positions.length, 0),
      followSignals: output.followSignals.length,
      hypothesesGenerated: output.hypothesesGenerated,
      topSignals: output.followSignals.slice(0, 5).map(s => ({
        market: s.market.substring(0, 50),
        outcome: s.outcome,
        traders: s.trader.substring(0, 50),
        confidence: s.confidence.toFixed(2)
      })),
      errors: output.errors
    };
    console.log(JSON.stringify(summary, null, 2));
    process.exit(output.errors.length > 3 ? 1 : 0);
  })
  .catch(error => {
    console.error(`Pipeline failed: ${error.message}`);
    process.exit(1);
  });
