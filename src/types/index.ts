import type Decimal from "decimal.js";

export interface PriceUpdate {
  symbol: "BTC" | "ETH";
  price: Decimal;
  timestamp: number;
  source: "binance" | "chainlink" | "coinbase";
}

export interface PriceDivergence {
  symbol: "BTC" | "ETH";
  exchangePrice: Decimal;
  oraclePrice: Decimal;
  divergencePercent: Decimal;
  timestamp: number;
  exchangeSource: string;
}

export interface PolymarketEvent {
  id: string;
  slug: string;
  title: string;
  startTime: string;
  endTime: string;
  markets: PolymarketMarket[];
}

export interface PolymarketMarket {
  id: string;
  conditionId: string;
  slug: string;
  question: string;
  outcomes: string[];
  outcomePrices: string[];
  volume: string;
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
  enableOrderBook: boolean;
  clobTokenIds?: string[];
}

export interface PolymarketPosition {
  asset: string;
  conditionId: string;
  outcomeIndex: number;
  size: string;
  avgPrice: string;
  curPrice: string;
  initialValue: string;
  currentValue: string;
  pnl: string;
  pnlPercent: string;
  market: string;
  title: string;
  outcome: string;
  eventSlug: string;
}

export interface TradeSignal {
  symbol: "BTC" | "ETH";
  direction: "UP" | "DOWN";
  confidence: number; // 0-1
  suggestedSize: Decimal;
  reason: string;
  timestamp: number;
  marketId?: string;
  targetPrice: Decimal;
  currentOdds: Decimal;
}

export interface Order {
  id: string;
  marketId: string;
  side: "BUY" | "SELL";
  size: Decimal;
  price: Decimal;
  status: "pending" | "filled" | "partial" | "cancelled" | "failed";
  createdAt: number;
  filledAt?: number;
}

export interface RiskLimits {
  maxPositionPercent: number; // Max % of bankroll per position
  maxExposurePercent: number; // Max total exposure
  maxDailyLossPercent: number; // Stop trading if daily loss exceeds
  minEdgeRequired: number; // Minimum edge to place bet
}

export interface TradingConfig {
  bankroll: Decimal;
  riskLimits: RiskLimits;
  symbols: ("BTC" | "ETH")[];
  dryRun: boolean;
  polygonRpcUrl: string;
  privateKey?: string;
}

export type PriceHandler = (update: PriceUpdate) => void;
export type DivergenceHandler = (divergence: PriceDivergence) => void;
export type SignalHandler = (signal: TradeSignal) => void;
