# Polymarket Liquidity Rewards Analysis
**Date:** 2025-12-09
**Hypothesis:** hyp-003 - Liquidity rewards create +EV market making opportunities
**Task:** research-003

## Executive Summary

Analyzed Polymarket's liquidity rewards program to calculate reward rates vs spreads. **Key finding: Rewards are modest ($1-20/day per market) and require significant capital deployment ($5,000-20,000 per market) to be meaningful. The opportunity exists but is NOT "easy money" - requires automation, capital, and sophisticated risk management.**

---

## Program Structure

### Two Reward Programs

1. **Liquidity Rewards** (Daily)
   - For posting limit orders (market making)
   - Quadratic scoring: closer to midpoint = higher rewards
   - **3x bonus for two-sided quotes** vs single-sided
   - Distributed daily at midnight UTC

2. **Holding Rewards** (Separate, 4% APY)
   - For holding positions in 13 eligible long-term markets
   - Not analyzed in this report

### Key Parameters (Per Market)

From CLOB API analysis of live markets:

| Parameter | Range Observed | Purpose |
|-----------|----------------|---------|
| `max_spread` | 3.5¢ - 4.5¢ | Max distance from midpoint to qualify |
| `min_size` | 50 - 200 shares | Minimum order size for rewards |
| `daily_rate` | $1 - $20 | Daily reward pool per market (USDC) |

---

## Live Market Data Analysis

Analyzed 10+ markets from CLOB API (`https://clob.polymarket.com/sampling-simplified-markets`):

### Sample Markets

| Market Type | Daily Rate | Min Size | Max Spread | Mid Price |
|------------|-----------|----------|------------|-----------|
| Tail risk (3.3%) | $3 | 100 | 3.5¢ | $0.033 |
| Tail risk (4.3%) | $2 | 100 | 3.5¢ | $0.043 |
| Mid-prob (17.4%) | $3 | 100 | 3.5¢ | $0.174 |
| Tail risk (3.2%) | $3 | 100 | 4.5¢ | $0.032 |
| Low-prob (4.8%) | $5 | 200 | 3.5¢ | $0.048 |
| High-prob (83%) | $3 | 100 | 3.5¢ | $0.830 |

### Observations

1. **Daily rates are modest:** $1-20 per market, most in $2-5 range
2. **Minimum capital requirement:** 100-200 shares × $0.50 avg = $50-100 minimum per side
3. **Spreads are tight:** 3.5¢ typical, 4.5¢ for more volatile markets
4. **Skewed toward tail markets:** Many low-probability (<10%) markets with rewards

---

## Reward/Spread Ratio Calculations

### Formula

For a market maker providing two-sided liquidity:

**Daily Reward per Market** = `daily_rate` × (your share of total liquidity within spread)

**Capital Required** = `min_size` × 2 sides × avg_price

**Annualized Return** = (daily_reward × 365) / capital_required

### Example: Tail Risk Market (3.3% probability)

**Parameters:**
- Daily rate: $3
- Min size: 100 shares
- Max spread: 3.5¢
- Mid price: $0.033 (YES), $0.967 (NO)

**Capital Required (two-sided, minimum):**
- YES side: 100 shares @ ~$0.03 = $3
- NO side: 100 shares @ ~$0.97 = $97
- **Total: ~$100**

**Reward Calculation:**
- Assume you capture 10% of total reward pool (competitive but achievable)
- Daily reward: $3 × 10% = $0.30/day
- **Annual: $109.50 on $100 capital = 109.5% APY**

**BUT:**
- Adverse selection risk: If YES moves to 10%, you lose $7 on position
- Need to adjust quotes continuously
- Competition for rewards reduces your share
- One bad fill wipes out weeks of rewards

### Example: Mid-Probability Market (17.4%)

**Parameters:**
- Daily rate: $3
- Min size: 100 shares
- Max spread: 3.5¢
- Mid price: $0.174 (YES), $0.826 (NO)

**Capital Required:**
- YES side: 100 @ $0.17 = $17
- NO side: 100 @ $0.83 = $83
- **Total: ~$100**

**Reward Calculation (10% share):**
- Daily: $0.30
- Annual: $109.50 on $100 = 109.5% APY

**Risk is HIGHER:**
- More volatile (17.4% vs 3.3%)
- Wider bid-ask spreads typically
- Greater adverse selection risk

### Scaling Analysis

**To earn $200/day (reported earnings):**
- Need to capture $200 across multiple markets
- At $0.30/day per market with 10% share → need ~667 markets
- More realistic: 15-20% share across 40-50 markets
- Requires: ~$100 × 50 markets = **$5,000 capital minimum**

**To earn $700/day (peak earnings):**
- ~$7,000-15,000 capital deployed
- 50-100 markets simultaneously
- Sophisticated bot managing inventory, spreads, risk

---

## Risk Analysis

### Adverse Selection

**Definition:** Informed traders pick off stale quotes when prices should move

**Example:**
- You quote YES @ 17¢, NO @ 18¢ (1¢ spread)
- News breaks → true price should be 25¢
- Informed trader buys your YES @ 18¢
- You're now underwater by 7¢ = **-7% loss instantly**
- That 7% loss = 23 days of rewards wiped out

**Mitigation:**
- Fast price updates (sub-second)
- Wide enough spreads to absorb small moves
- Cancel orders during volatile periods
- Monitor news/social feeds

### Capital Risk

- Need $5,000-20,000 deployed across markets
- Inventory can become unbalanced (long on some, short on others)
- Market resolution risk if holding directional positions

### Competition Risk

- Your reward share = your liquidity / total liquidity within spread
- If 10 other MMs enter your markets, your share drops 10x
- Post-election 2024: "rewards decreased significantly"

### Operational Risk

- Bot downtime = missed rewards + stale quotes
- API rate limits
- Exchange connectivity issues
- Smart contract risk (Polymarket CLOB)

---

## Profitability Assessment

### Income Sources

1. **Spread capture:** Bid-ask spread when trades execute
2. **Liquidity rewards:** Daily rewards (focus of this analysis)
3. **Holding rewards:** 4% APY on positions (separate program)

### Expense Sources

1. **Adverse selection:** Getting picked off on directional moves
2. **Gas fees:** Minimal on Polygon but non-zero
3. **Infrastructure:** Server costs, data feeds, monitoring

### Break-Even Analysis

**Scenario: Conservative MM**
- Capital: $10,000
- Markets: 50
- Avg daily rate: $3/market
- Your share: 10%
- Daily earnings: 50 × $3 × 10% = $15/day = $5,475/year

**Return: 54.75% APY before adverse selection**

**With adverse selection losses:**
- Assume 2% monthly adverse selection drag = 24% annual
- Net return: 54.75% - 24% = **30.75% APY**

**Conclusion:** Profitable but requires:
- $10k+ capital
- Sophisticated bot
- Risk management
- Active monitoring

### Comparison to Alternative Strategies

| Strategy | Capital | Time | Expected Return | Risk |
|----------|---------|------|-----------------|------|
| Liquidity Rewards | $10k | High (bot building) | 30-50% | Medium (adverse selection) |
| Directional Trading | $1k | Medium | -10% to +100% | High (market risk) |
| Arbitrage (single-market) | $5k | High (speed required) | 20-40% | Low (execution risk) |
| Copy Top Traders | $1k | Low | Unknown | High (following bias) |

---

## Current Market Conditions (Dec 2025)

### Post-Election Impact

From research:
> "Post-2024 election: Total liquidity rewards decreased significantly"

**Implications:**
- Smaller reward pools than historical $200-800/day reports
- Need to verify current total rewards budget
- May be less attractive now vs 2024

### Competition Level

From research:
> "Competition 'not fierce' currently but window likely narrowing"

**Assessment:** First-mover advantage still exists but closing

---

## Infrastructure Requirements

### To Test This Hypothesis

1. **Automated Order Placement**
   - CLOB API integration
   - Sub-second order updates
   - Two-sided quote management

2. **Real-Time Monitoring**
   - Fetch orderbook every 1-5 seconds
   - Track price movements
   - Detect adverse selection

3. **Inventory Management**
   - Track positions across 50+ markets
   - Rebalance when skewed
   - Exit directional exposure

4. **Reward Tracking**
   - Monitor daily reward distributions
   - Calculate actual vs expected
   - Adjust market selection

### Build vs Buy

**Option 1: Build from scratch**
- Timeline: 2-4 weeks
- Use py-clob-client or clob-client (TypeScript)
- Custom logic for all above components

**Option 2: Fork existing**
- Search for open-source Polymarket MM bots
- Adapt to our strategy
- Timeline: 1-2 weeks

**Option 3: Start manual**
- Place orders manually for 5-10 markets
- Track rewards for 7 days
- Validate profitability before automating

---

## Recommendations

### Hypothesis hyp-003 Assessment

**Original statement:** "Polymarket liquidity rewards create +EV market making opportunities despite adverse selection risk"

**Verdict: PARTIALLY VALIDATED**

✅ **Rewards exist and are measurable:** $1-20/day per market
✅ **Can be +EV with proper execution:** 30-50% APY possible
✅ **Two-sided bonus (3x) creates structural advantage**

❌ **NOT "risk-free" as initially hypothesized**
❌ **Requires significant capital ($5k-20k) to scale**
❌ **Infrastructure is substantial (2-4 week build)**
❌ **Post-election rewards reduced significantly**

### Recommended Next Steps

**DEFER for now. Prioritize faster-to-test hypotheses.**

**Rationale:**
1. **High infrastructure barrier:** 2-4 weeks to build bot
2. **Capital intensive:** Need $10k deployed to earn meaningful rewards
3. **Uncertain current conditions:** Post-election reward reduction unknown magnitude
4. **Other hypotheses are more executable:** hyp-002 (momentum), hyp-mixz8efs (geopolitical), etc. require no new infrastructure

**IF we pursue later:**
1. Start with manual testing (5 markets, 7 days)
2. Validate actual reward distributions vs estimates
3. Build simple bot for 1-2 markets
4. Scale if profitability confirmed

### Update to Hypothesis

Add to evidence:
```
{
  "date": "2025-12-09",
  "observation": "Analyzed live CLOB API data. Daily rates $1-20/market, typical spreads 3.5¢, min capital $100/market. To earn reported $200-800/day requires $5k-20k capital across 50-100 markets. Returns 30-50% APY possible but requires sophisticated bot, not simple strategy. Post-election reward reduction noted in research. Defer due to high infrastructure cost vs other testable hypotheses.",
  "supports": true,
  "confidenceImpact": 0
}
```

**Maintain confidence at 0.45 (unchanged)** - rewards exist and can be +EV, but practical barriers are higher than initial assessment.

---

## Sources

- [Polymarket Liquidity Rewards Documentation](https://docs.polymarket.com/polymarket-learn/trading/liquidity-rewards)
- [Polymarket CLOB API - Get Markets](https://docs.polymarket.com/developers/CLOB/markets/get-markets)
- [Automated Market Making on Polymarket](https://news.polymarket.com/p/automated-market-making-on-polymarket)
- [Polymarket Market Making Rewards Program Overview](https://mirror.xyz/polymarket.eth/TOHA3ir5R76bO1vjTrKQclS9k8Dygma53OIzHztJSjk)
- Live CLOB API data: `https://clob.polymarket.com/sampling-simplified-markets`

---

## Appendix: Raw Data Sample

```json
{
  "condition_id": "0xc30cf...",
  "rewards": {
    "rates": [{"asset_address": "0x2791...", "rewards_daily_rate": 3}],
    "min_size": 100,
    "max_spread": 3.5
  },
  "tokens": [
    {"token_id": "2874...", "outcome": "Yes", "price": 0.0335},
    {"token_id": "5212...", "outcome": "No", "price": 0.9665}
  ],
  "active": true,
  "accepting_orders": true
}
```

Markets analyzed: 10+ from live API, representing tail-risk, mid-probability, and high-probability events across various categories.
