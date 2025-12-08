/**
 * Closing-Soon Scanner Pipeline (imp-008)
 *
 * Scans markets closing within 72 hours, checks for momentum signals,
 * and generates hypothesis candidates for testing hyp-002.
 *
 * Usage: npx ts-node tools/pipelines/closing-scanner.ts
 * Output: JSON to stdout with candidate hypotheses
 */

import * as fs from 'fs';
import * as path from 'path';

const STATE_DIR = path.join(__dirname, '../../state');
const HYPOTHESES_FILE = path.join(STATE_DIR, 'hypotheses.json');
const ENGINE_STATUS_FILE = path.join(STATE_DIR, 'engine-status.json');

interface MarketCandidate {
  marketId: string;
  slug: string;
  question: string;
  closingAt: string;
  hoursUntilClose: number;
  currentPrice: number;
  priceChange24h: number | null;
  volume24h: number;
  momentumSignal: 'strong_yes' | 'strong_no' | 'weak' | 'none';
  recommendation: string;
}

interface PipelineOutput {
  runAt: string;
  marketsScanned: number;
  candidatesFound: number;
  candidates: MarketCandidate[];
  hypothesesGenerated: string[];
  errors: string[];
}

// We'll call the Polymarket MCP through Claude, but for the pipeline
// we need to make direct API calls. Using the public CLOB API.
const POLYMARKET_API = 'https://clob.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';

async function fetchClosingSoonMarkets(hours: number = 72): Promise<any[]> {
  try {
    // Use gamma API for market discovery
    const response = await fetch(`${GAMMA_API}/markets?closed=false&limit=100`);
    if (!response.ok) {
      throw new Error(`Gamma API error: ${response.status}`);
    }

    const markets = await response.json() as any[];
    const now = new Date();
    const cutoff = new Date(now.getTime() + hours * 60 * 60 * 1000);

    // Filter to markets closing within the window
    return markets.filter((m: any) => {
      if (!m.endDate) return false;
      const endDate = new Date(m.endDate);
      return endDate > now && endDate <= cutoff;
    });
  } catch (error: any) {
    console.error(`Error fetching markets: ${error.message}`);
    return [];
  }
}

async function getMarketPrice(tokenId: string): Promise<number | null> {
  try {
    const response = await fetch(`${POLYMARKET_API}/price?token_id=${tokenId}&side=buy`);
    if (!response.ok) return null;
    const data = await response.json() as any;
    return data.price ? parseFloat(data.price) : null;
  } catch {
    return null;
  }
}

async function getPriceHistory(tokenId: string): Promise<{price24hAgo: number | null}> {
  // The CLOB API has limited historical data access
  // For now, we'll return null and note this as a capability gap
  // TODO: Build price history tracking (imp-003 related)
  return { price24hAgo: null };
}

function calculateMomentumSignal(
  currentPrice: number,
  priceChange24h: number | null,
  hoursUntilClose: number
): 'strong_yes' | 'strong_no' | 'weak' | 'none' {
  if (priceChange24h === null) return 'none';

  // Strong momentum: price moved >10% in direction of outcome
  // and price is >70% or <30% (approaching resolution)
  const absChange = Math.abs(priceChange24h);

  if (absChange > 0.10) {
    if (currentPrice > 0.70 && priceChange24h > 0) return 'strong_yes';
    if (currentPrice < 0.30 && priceChange24h < 0) return 'strong_no';
  }

  if (absChange > 0.05) return 'weak';

  return 'none';
}

function generateHypothesisFromCandidate(candidate: MarketCandidate): any {
  const direction = candidate.momentumSignal === 'strong_yes' ? 'YES' : 'NO';
  const targetPrice = candidate.momentumSignal === 'strong_yes'
    ? Math.min(0.95, candidate.currentPrice + 0.10)
    : Math.max(0.05, candidate.currentPrice - 0.10);

  return {
    id: `hyp-auto-${Date.now()}`,
    statement: `Market "${candidate.slug}" will continue momentum toward ${direction} before closing`,
    rationale: `Price moved ${((candidate.priceChange24h || 0) * 100).toFixed(1)}% in 24h with ${candidate.hoursUntilClose.toFixed(0)}h until close. Momentum hypothesis suggests continuation.`,
    source: "platform",
    sourcePipeline: "closing-scanner",
    testMethod: `Buy ${direction} at current price (~${(candidate.currentPrice * 100).toFixed(0)}¢), target ${(targetPrice * 100).toFixed(0)}¢ or hold to resolution.`,
    entryRules: `Current price ${direction === 'YES' ? '>' : '<'} ${(candidate.currentPrice * 100).toFixed(0)}¢, momentum signal: ${candidate.momentumSignal}`,
    exitRules: `Target: ${(targetPrice * 100).toFixed(0)}¢, Stop: ${((candidate.currentPrice + (direction === 'YES' ? -0.05 : 0.05)) * 100).toFixed(0)}¢, or hold to resolution`,
    expectedWinRate: 0.55,
    expectedPayoff: 1.5,
    minSampleSize: 10,
    status: "proposed",
    confidence: 0.35,
    evidence: [],
    conclusion: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    linkedMarket: {
      slug: candidate.slug,
      question: candidate.question,
      closingAt: candidate.closingAt
    }
  };
}

async function runPipeline(): Promise<PipelineOutput> {
  const output: PipelineOutput = {
    runAt: new Date().toISOString(),
    marketsScanned: 0,
    candidatesFound: 0,
    candidates: [],
    hypothesesGenerated: [],
    errors: []
  };

  console.error('Starting closing-scanner pipeline...');

  // Fetch markets closing in 72 hours
  const markets = await fetchClosingSoonMarkets(72);
  output.marketsScanned = markets.length;
  console.error(`Found ${markets.length} markets closing within 72 hours`);

  if (markets.length === 0) {
    output.errors.push('No markets found closing within 72 hours');
    return output;
  }

  // Analyze each market
  for (const market of markets) {
    try {
      // Get the YES token (first outcome usually)
      const yesToken = market.clobTokenIds?.[0];
      if (!yesToken) continue;

      const currentPrice = await getMarketPrice(yesToken);
      if (currentPrice === null) continue;

      const { price24hAgo } = await getPriceHistory(yesToken);
      const priceChange24h = price24hAgo !== null
        ? currentPrice - price24hAgo
        : null;

      const endDate = new Date(market.endDate);
      const hoursUntilClose = (endDate.getTime() - Date.now()) / (1000 * 60 * 60);

      const momentumSignal = calculateMomentumSignal(
        currentPrice,
        priceChange24h,
        hoursUntilClose
      );

      const candidate: MarketCandidate = {
        marketId: market.id,
        slug: market.slug || market.id,
        question: market.question || 'Unknown',
        closingAt: market.endDate,
        hoursUntilClose,
        currentPrice,
        priceChange24h,
        volume24h: market.volume24hr || 0,
        momentumSignal,
        recommendation: momentumSignal !== 'none'
          ? `Consider ${momentumSignal.includes('yes') ? 'YES' : 'NO'} position`
          : 'No clear signal'
      };

      // Only include candidates with momentum signals
      if (momentumSignal !== 'none') {
        output.candidates.push(candidate);
      }
    } catch (error: any) {
      output.errors.push(`Error analyzing ${market.slug}: ${error.message}`);
    }
  }

  output.candidatesFound = output.candidates.length;
  console.error(`Found ${output.candidatesFound} candidates with momentum signals`);

  // Generate hypotheses for strong signals
  const strongCandidates = output.candidates.filter(
    c => c.momentumSignal.startsWith('strong')
  );

  if (strongCandidates.length > 0) {
    // Load existing hypotheses
    let hypotheses: any = { hypotheses: [] };
    try {
      hypotheses = JSON.parse(fs.readFileSync(HYPOTHESES_FILE, 'utf-8'));
    } catch {}

    for (const candidate of strongCandidates.slice(0, 3)) { // Max 3 new hypotheses per run
      const newHyp = generateHypothesisFromCandidate(candidate);
      hypotheses.hypotheses.push(newHyp);
      output.hypothesesGenerated.push(newHyp.id);
      console.error(`Generated hypothesis: ${newHyp.id} for ${candidate.slug}`);
    }

    // Save updated hypotheses
    fs.writeFileSync(HYPOTHESES_FILE, JSON.stringify(hypotheses, null, 2));

    // Update pipeline stats
    if (hypotheses.pipelineStats?.platform) {
      hypotheses.pipelineStats.platform.generated += output.hypothesesGenerated.length;
    }
  }

  // Update engine status
  try {
    const engineStatus = JSON.parse(fs.readFileSync(ENGINE_STATUS_FILE, 'utf-8'));
    engineStatus.lastEvaluated = new Date().toISOString();
    engineStatus.metrics.hypothesesGeneratedThisWeek += output.hypothesesGenerated.length;

    // Recalculate hypothesis health
    const hypotheses = JSON.parse(fs.readFileSync(HYPOTHESES_FILE, 'utf-8'));
    engineStatus.hypothesisHealth.total = hypotheses.hypotheses.length;
    engineStatus.hypothesisHealth.byStatus = {
      proposed: hypotheses.hypotheses.filter((h: any) => h.status === 'proposed').length,
      testing: hypotheses.hypotheses.filter((h: any) => h.status === 'testing').length,
      validated: hypotheses.hypotheses.filter((h: any) => h.status === 'validated').length,
      invalidated: hypotheses.hypotheses.filter((h: any) => h.status === 'invalidated').length
    };

    fs.writeFileSync(ENGINE_STATUS_FILE, JSON.stringify(engineStatus, null, 2));
  } catch (error: any) {
    output.errors.push(`Failed to update engine status: ${error.message}`);
  }

  return output;
}

// Run the pipeline
runPipeline()
  .then(output => {
    console.log(JSON.stringify(output, null, 2));
    process.exit(output.errors.length > 0 ? 1 : 0);
  })
  .catch(error => {
    console.error(`Pipeline failed: ${error.message}`);
    process.exit(1);
  });
