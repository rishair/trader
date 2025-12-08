#!/bin/bash
cd /opt/trader
npx ts-node tools/arbitrage/shadow-detector.ts --verbose 2>&1 | tee -a state/trading/shadow-detector.log
