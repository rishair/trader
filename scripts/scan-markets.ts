import { searchMarkets, getTrendingMarkets } from '../tools/mcp/polymarket.js';

async function scanMarkets() {
  const trending = await getTrendingMarkets({ limit: 10 });
  const trump = await searchMarkets({ query: 'Trump', limit: 5 });
  const ai = await searchMarkets({ query: 'AI', limit: 5 });
  const bitcoin = await searchMarkets({ query: 'Bitcoin', limit: 5 });
  const crypto = await searchMarkets({ query: 'crypto', limit: 5 });

  console.log(JSON.stringify({ trending, trump, ai, bitcoin, crypto }, null, 2));
}

scanMarkets().catch(console.error);
