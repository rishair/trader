/**
 * Detailed market search for Polymarket
 * Attempts multiple API endpoints to get comprehensive market data
 */

const GAMMA_API = 'https://gamma-api.polymarket.com';
const POLYMARKET_API = 'https://clob.polymarket.com';

interface MarketData {
  id: string;
  slug: string;
  question: string;
  endDate: string;
  hoursUntilClose: number;
  daysUntilClose: number;
  volume24h: number;
  liquidity: number;
  category?: string;
  outcomeTokens: string[];
  yesPrice?: number;
  noPrice?: number;
  priceTrend?: string;
  liquidityLevel: 'low' | 'medium' | 'high';
  volumeLevel: 'low' | 'medium' | 'high';
  suitabilityScore: number;
}

async function getMarketPriceAttempts(tokenId: string): Promise<{ yes?: number; no?: number }> {
  const prices: { yes?: number; no?: number } = {};

  // Attempt 1: Direct price endpoint
  try {
    const resp = await fetch(`${POLYMARKET_API}/price?token_id=${tokenId}&side=buy`);
    if (resp.ok) {
      const data = await resp.json() as any;
      if (data.price) {
        prices.yes = parseFloat(data.price);
      }
    }
  } catch {}

  // Attempt 2: Orderbook endpoint
  try {
    const resp = await fetch(`${POLYMARKET_API}/orderbook/${tokenId}`);
    if (resp.ok) {
      const data = await resp.json() as any;
      if (data.bids && data.bids.length > 0) {
        prices.yes = parseFloat(data.bids[0][0]);
      }
    }
  } catch {}

  return prices;
}

function classifyLiquidityLevel(liquidity: number): 'low' | 'medium' | 'high' {
  if (liquidity > 50000) return 'high';
  if (liquidity > 5000) return 'medium';
  return 'low';
}

function classifyVolumeLevel(volume: number): 'low' | 'medium' | 'high' {
  if (volume > 10000) return 'high';
  if (volume > 1000) return 'medium';
  return 'low';
}

function calculateSuitabilityScore(market: Partial<MarketData>): number {
  let score = 0;

  // Price range: prefer 20%-80% range
  if (market.yesPrice !== undefined) {
    if (market.yesPrice > 0.2 && market.yesPrice < 0.8) {
      score += 30;
    } else if (market.yesPrice > 0.05 && market.yesPrice < 0.95) {
      score += 15;
    }
  } else {
    score += 5; // Unknown price is worse than extreme
  }

  // Liquidity: prefer medium to high
  if (market.liquidityLevel === 'high') {
    score += 25;
  } else if (market.liquidityLevel === 'medium') {
    score += 15;
  }

  // Volume: prefer higher volume for momentum analysis
  if (market.volumeLevel === 'high') {
    score += 25;
  } else if (market.volumeLevel === 'medium') {
    score += 10;
  }

  // Time to close: prefer not too close
  if (market.hoursUntilClose !== undefined) {
    if (market.hoursUntilClose > 24 && market.hoursUntilClose < 144) {
      score += 15;
    } else if (market.hoursUntilClose > 6 && market.hoursUntilClose < 168) {
      score += 5;
    }
  }

  return Math.min(100, score);
}

async function fetchMarketsClosingSoon(hoursWindow: number = 168): Promise<MarketData[]> {
  console.error(`Fetching markets closing within ${hoursWindow} hours...`);

  const markets: MarketData[] = [];
  const now = new Date();
  const cutoff = new Date(now.getTime() + hoursWindow * 60 * 60 * 1000);

  try {
    // Fetch from Gamma API
    const response = await fetch(`${GAMMA_API}/markets?limit=500&closed=false`);
    if (!response.ok) {
      throw new Error(`Gamma API error: ${response.status}`);
    }

    const allMarkets = await response.json() as any[];
    console.error(`Total markets fetched: ${allMarkets.length}`);

    // Filter and process
    for (const market of allMarkets) {
      if (!market.endDate) continue;

      const endDate = new Date(market.endDate);
      if (endDate <= now || endDate > cutoff) continue;

      const hoursUntilClose = (endDate.getTime() - now.getTime()) / (1000 * 60 * 60);
      const daysUntilClose = hoursUntilClose / 24;

      // Try to get prices
      const prices: { yes?: number; no?: number } = {};
      if (market.clobTokenIds && market.clobTokenIds.length > 0) {
        const priceData = await getMarketPriceAttempts(market.clobTokenIds[0]);
        if (priceData.yes !== undefined) {
          prices.yes = priceData.yes;
          prices.no = 1 - priceData.yes;
        }
      }

      const liquidityLevel = classifyLiquidityLevel(parseFloat(market.liquidity || '0'));
      const volumeLevel = classifyVolumeLevel(market.volume24hr || 0);

      const marketData: MarketData = {
        id: market.id,
        slug: market.slug || market.id,
        question: market.question || 'Unknown',
        endDate: market.endDate,
        hoursUntilClose,
        daysUntilClose,
        volume24h: market.volume24hr || 0,
        liquidity: parseFloat(market.liquidity || '0'),
        category: market.category,
        outcomeTokens: market.clobTokenIds || [],
        yesPrice: prices.yes,
        noPrice: prices.no,
        liquidityLevel,
        volumeLevel,
        suitabilityScore: 0 // Will be calculated next
      };

      // Calculate suitability
      marketData.suitabilityScore = calculateSuitabilityScore(marketData);

      markets.push(marketData);
    }

    // Sort by suitability
    markets.sort((a, b) => b.suitabilityScore - a.suitabilityScore);

    return markets;
  } catch (error: any) {
    console.error(`Error fetching markets: ${error.message}`);
    return markets;
  }
}

async function main() {
  const hours = parseInt(process.argv[2] || '168', 10);
  const limit = parseInt(process.argv[3] || '20', 10);

  console.error(`Searching for markets closing within ${hours} hours (by ${new Date(Date.now() + hours * 60 * 60 * 1000).toISOString().split('T')[0]})...\n`);

  const markets = await fetchMarketsClosingSoon(hours);

  // Filter to top matches by suitability
  const topMarkets = markets.slice(0, limit);

  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    hoursWindow: hours,
    windowEnds: new Date(Date.now() + hours * 60 * 60 * 1000).toISOString(),
    totalFound: markets.length,
    topMatches: limit,
    markets: topMarkets
  }, null, 2));

  console.error(`\nFound ${markets.length} markets closing within ${hours} hours`);
  console.error(`Top ${limit} by suitability score:`);
  topMarkets.forEach((m, idx) => {
    console.error(`${idx + 1}. [Score: ${m.suitabilityScore}] ${m.question.substring(0, 60)}`);
    console.error(`   Price: ${m.yesPrice ? (m.yesPrice * 100).toFixed(1) : 'N/A'}% | Volume: $${(m.volume24h / 1000).toFixed(1)}k | Closes in ${m.daysUntilClose.toFixed(1)}d`);
  });
}

main().catch(error => {
  console.error(`Script failed: ${error.message}`);
  process.exit(1);
});
