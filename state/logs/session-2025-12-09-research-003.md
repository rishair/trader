# Research Session: Liquidity Rewards Analysis (research-003)

**Date**: 2025-12-09
**Task ID**: research-003
**Hypothesis**: hyp-003
**Duration**: ~45 minutes
**Agent**: Trade Research Engineer (autonomous wake-up)

---

## Mission

Analyze Polymarket's liquidity rewards program:
1. Calculate reward rates vs spreads
2. Validate existing deep analysis from Dec 8
3. Check current market conditions via live API

---

## Key Discovery: Rewards Program INACTIVE ⚠️

### Critical Finding

**Live CLOB API verification revealed**: ZERO active markets have reward parameters set.

```
Markets checked: 1,000
Markets with rewards.max_spread > 0: 0
Markets with rewards.min_size > 0: 0
Markets with rewards.rates ≠ null: 0
```

**Conclusion**: Liquidity rewards program is currently **INACTIVE** as of December 9, 2025.

---

## Analysis Performed

### 1. Live API Verification
- Queried CLOB API for all 1,000 markets
- Filtered for active markets accepting orders with reward parameters
- Result: ZERO markets matched criteria

### 2. ROI Calculations (Theoretical)
Built comprehensive model showing returns IF rewards were active:
- $1k capital: $35/day (insufficient diversification)
- $5k capital: $275/day (marginal viability)
- $10k capital: $900/day (viable with active rewards)

**BUT**: All scenarios assume $2-5/market/day rewards. With ZERO rewards, none are viable.

### 3. Adverse Selection Impact
- Gross spread capture: ~2¢ per trade
- Adverse selection cost: 70-90% of gross
- Net without rewards: 0.2-0.6¢ per trade
- Conclusion: NOT worth infrastructure investment

---

## Hypothesis Status Update

**hyp-003 transitioned**: testing → **invalidated**

**Reason**: Program currently inactive, making market making NOT +EV.

**Confidence**: 25% (down from 55%)

---

## Learning Added

**ID**: learning-miyfu8g2-eaoo
**Claim**: "Polymarket liquidity rewards program is INACTIVE as of Dec 9, 2025"
**Confidence**: 95%

---

## Implications

### For Trading Strategy
1. DO NOT pursue market making until rewards reactivate
2. Focus on executable hypotheses (sports, momentum, arbitrage)
3. Save 4-7 weeks of infrastructure development time

### Monitoring Strategy
Check CLOB API weekly for reward parameter changes:
```bash
curl -s "https://clob.polymarket.com/markets" | jq '.data[] | select(.rewards.max_spread > 0) | .question'
```

---

## Session Output

**Primary Output**: Hypothesis invalidated - program inactive
**Portfolio Impact**: None (no trades)
**Knowledge Impact**: High - prevents pursuing non-viable strategy

**Session Complete** ✓
