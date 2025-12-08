# Strategy Organization

Each strategy lives in its own directory with a standardized structure.

## Directory Structure

```
strategies/
├── README.md (this file)
├── active/           # Strategies currently trading
├── testing/          # Strategies being validated
├── research/         # Strategy ideas being explored
└── retired/          # Strategies that didn't work (keep for learning)
```

## Strategy Template

Each strategy directory contains:

```
strategy-name/
├── STRATEGY.md       # Strategy definition and rules
├── hypothesis.json   # The hypothesis this tests
├── backtest/         # Backtest results and data
├── trades.json       # Trade history for this strategy
├── performance.json  # Performance metrics
└── notes.md          # Observations and learnings
```

## Strategy Lifecycle

1. **research/** - Initial exploration, gathering data
2. **testing/** - Paper trading with small positions
3. **active/** - Validated, running with full allocation
4. **retired/** - Stopped (document why)

## Naming Convention

`{category}-{descriptor}-{version}`

Examples:
- `momentum-news-v1`
- `arbitrage-related-markets-v2`
- `mean-reversion-overreaction-v1`
