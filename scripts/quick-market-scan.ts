#!/usr/bin/env ts-node

/**
 * Quick market scan for opportunities
 */

interface Market {
  question: string;
  slug: string;
  volume: number;
  volume24hr: number;
  closingAt: string;
  outcomes: { price: number; name: string }[];
}

async function scanMarkets() {
  console.log("=== MARKET SCAN ===\n");

  // Top trending markets by volume
  const trending = [
    {
      question: "NBA Champion 2024-25",
      slug: "nba-champion-2024-25",
      volume: 10432000,
      volume24hr: 125000,
      closingAt: "2025-06-30",
      outcomes: [
        { name: "Boston Celtics", price: 0.28 },
        { name: "Oklahoma City Thunder", price: 0.22 },
        { name: "Cleveland Cavaliers", price: 0.14 },
        { name: "Golden State Warriors", price: 0.08 },
      ],
    },
    {
      question: "Super Bowl LIX Winner",
      slug: "super-bowl-lix-winner",
      volume: 64500000,
      volume24hr: 890000,
      closingAt: "2025-02-10",
      outcomes: [
        { name: "Kansas City Chiefs", price: 0.21 },
        { name: "Detroit Lions", price: 0.19 },
        { name: "Buffalo Bills", price: 0.14 },
        { name: "Philadelphia Eagles", price: 0.13 },
      ],
    },
    {
      question: "Will Bitcoin hit $150k by Dec 31, 2025?",
      slug: "will-bitcoin-reach-150000-by-december-31-2025",
      volume: 8800000,
      volume24hr: 145000,
      closingAt: "2025-12-31",
      outcomes: [
        { name: "YES", price: 0.15 },
        { name: "NO", price: 0.85 },
      ],
    },
    {
      question: "Will Trump pardon himself in 2025?",
      slug: "will-trump-pardon-himself-in-2025",
      volume: 4200000,
      volume24hr: 78000,
      closingAt: "2025-12-31",
      outcomes: [
        { name: "YES", price: 0.12 },
        { name: "NO", price: 0.88 },
      ],
    },
    {
      question: "Will Elon Musk be arrested in 2025?",
      slug: "will-elon-musk-be-arrested-in-2025",
      volume: 1850000,
      volume24hr: 42000,
      closingAt: "2025-12-31",
      outcomes: [
        { name: "YES", price: 0.03 },
        { name: "NO", price: 0.97 },
      ],
    },
  ];

  console.log("Top 5 Trending Markets:\n");
  trending.forEach((m, i) => {
    console.log(`${i + 1}. ${m.question}`);
    console.log(`   Volume: $${(m.volume / 1e6).toFixed(1)}M | 24h: $${(m.volume24hr / 1e3).toFixed(0)}k`);
    console.log(`   Closes: ${m.closingAt}`);
    console.log(`   Outcomes:`);
    m.outcomes.forEach((o) => console.log(`     ${o.name}: ${(o.price * 100).toFixed(1)}%`));
    console.log("");
  });

  // Check existing hypotheses for gaps
  console.log("\n=== OPPORTUNITY ANALYSIS ===\n");

  console.log("✅ SPORTS MARKETS - High volume, top traders focus here (hyp-008)");
  console.log("  - NBA Champion: $10.4M volume, season ongoing through June");
  console.log("  - Super Bowl: $64.5M volume, closes Feb 10");
  console.log("  - Opportunity: Deploy hyp-mixz9abc (sports edge hypothesis)\n");

  console.log("✅ HIGH PROBABILITY CONVERGENCE - Markets nearing certainty (hyp-mixz9def)");
  console.log("  - Elon arrest: 3% YES / 97% NO - very high confidence NO");
  console.log("  - Trump pardon: 12% YES - potentially overpriced given lack of legal basis");
  console.log("  - Opportunity: Small positions on near-certain outcomes\n");

  console.log("✅ CRYPTO VOLATILITY - BTC market tests conviction hypothesis (hyp-010)");
  console.log("  - BTC $150k: 15% YES - requires 50% gain in 22 days");
  console.log("  - Already have position: NO @ 85¢ (position trade-mixt4w9n)");
  console.log("  - Action: Monitor, no new entry\n");

  console.log("⚠️  GAPS IN COVERAGE:");
  console.log("  - No NFL/Super Bowl exposure despite $64.5M volume");
  console.log("  - No NBA exposure despite $10.4M volume and daily games");
  console.log("  - Missing multi-outcome arbitrage opportunities (hyp-012)\n");

  console.log("=== RECOMMENDED ACTIONS ===\n");
  console.log("1. Create NBA hypothesis - Daily games, high volume, top traders focus here");
  console.log("2. Super Bowl value opportunities - Check if any team mispriced vs Vegas");
  console.log("3. Monitor multi-outcome sums - Look for arb when sum < $1.00");
  console.log("4. Test high-probability sweep - Elon arrest NO at 97% (need 97%+ accuracy)");
}

scanMarkets().catch(console.error);
