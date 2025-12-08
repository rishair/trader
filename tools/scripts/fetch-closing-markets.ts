/**
 * Fetch all markets closing within specified hours
 * Shows detailed info including price, volume, liquidity
 *
 * Usage: npx ts-node tools/scripts/fetch-closing-markets.ts [hours]
 * Example: npx ts-node tools/scripts/fetch-closing-markets.ts 168
 */

const GAMMA_API = 'https://gamma-api.polymarket.com';
const POLYMARKET_API = 'https://clob.polymarket.com';

interface Market {
  id: string;
  slug: string;
  question: string;
  endDate: string;
  hoursUntilClose: number;
  currentPrice: number | null;
  volume24h: number;
  liquidity: number;
  outcomeTokens: any[];
}

async function fetchClosingMarkets(hoursWindow: number = 168): Promise<Market[]> {
  try {
    console.error(`Fetching markets closing within ${hoursWindow} hours (by ${new Date(Date.now() + hoursWindow * 60 * 60 * 1000).toISOString()})...`);

    // Get all markets
    const response = await fetch(`${GAMMA_API}/markets?closed=false&limit=1000`);
    if (!response.ok) {
      throw new Error(`Gamma API error: ${response.status}`);
    }

    const markets = await response.json() as any[];
    console.error(`Total markets fetched: ${markets.length}`);

    const now = new Date();
    const cutoff = new Date(now.getTime() + hoursWindow * 60 * 60 * 1000);

    // Filter to markets closing within the window
    const closingSoon = markets.filter((m: any) => {
      if (!m.endDate) return false;
      const endDate = new Date(m.endDate);
      return endDate > now && endDate <= cutoff;
    });

    console.error(`Markets closing within ${hoursWindow} hours: ${closingSoon.length}`);

    // Fetch detailed data for each market
    const detailedMarkets: Market[] = [];

    for (const market of closingSoon) {
      try {
        const yesToken = market.clobTokenIds?.[0];
        const noToken = market.clobTokenIds?.[1];

        let currentPrice: number | null = null;

        // Try to get current price for YES outcome
        if (yesToken) {
          try {
            const priceResponse = await fetch(`${POLYMARKET_API}/price?token_id=${yesToken}&side=buy`);
            if (priceResponse.ok) {
              const priceData = await priceResponse.json() as any;
              currentPrice = priceData.price ? parseFloat(priceData.price) : null;
            }
          } catch {
            // Price fetch failed, continue with null
          }
        }

        const endDate = new Date(market.endDate);
        const hoursUntilClose = (endDate.getTime() - now.getTime()) / (1000 * 60 * 60);

        const detailedMarket: Market = {
          id: market.id,
          slug: market.slug || market.id,
          question: market.question || 'Unknown',
          endDate: market.endDate,
          hoursUntilClose,
          currentPrice,
          volume24h: market.volume24hr || 0,
          liquidity: market.liquidity || 0,
          outcomeTokens: market.clobTokenIds || []
        };

        detailedMarkets.push(detailedMarket);
      } catch (error: any) {
        console.error(`Error processing market ${market.slug}: ${error.message}`);
      }
    }

    // Sort by hours until close (closest first)
    detailedMarkets.sort((a, b) => a.hoursUntilClose - b.hoursUntilClose);

    return detailedMarkets;
  } catch (error: any) {
    console.error(`Fatal error fetching markets: ${error.message}`);
    throw error;
  }
}

async function main() {
  const hoursArg = process.argv[2];
  const hours = hoursArg ? parseInt(hoursArg, 10) : 168; // Default 7 days

  if (isNaN(hours)) {
    console.error('Invalid hours argument');
    process.exit(1);
  }

  const markets = await fetchClosingMarkets(hours);

  // Output as JSON
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    hoursWindow: hours,
    windowEnds: new Date(Date.now() + hours * 60 * 60 * 1000).toISOString(),
    totalFound: markets.length,
    markets: markets
  }, null, 2));
}

main().catch(error => {
  console.error(`Script failed: ${error.message}`);
  process.exit(1);
});
