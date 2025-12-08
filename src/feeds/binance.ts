import WebSocket from "ws";
import Decimal from "decimal.js";
import { logger } from "../utils/logger.js";
import type { PriceUpdate, PriceHandler } from "../types/index.js";

interface BinanceTradeMessage {
  e: string; // Event type
  E: number; // Event time
  s: string; // Symbol
  p: string; // Price
  q: string; // Quantity
  T: number; // Trade time
}

interface BinanceBookTickerMessage {
  u: number; // Order book updateId
  s: string; // Symbol
  b: string; // Best bid price
  B: string; // Best bid qty
  a: string; // Best ask price
  A: string; // Best ask qty
}

const BINANCE_WS_URL = "wss://stream.binance.com:9443/ws";

export class BinanceFeed {
  private ws: WebSocket | null = null;
  private handlers: PriceHandler[] = [];
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1000;
  private isRunning = false;
  private lastPrices: Map<string, PriceUpdate> = new Map();

  constructor(private symbols: ("BTC" | "ETH")[]) {}

  subscribe(handler: PriceHandler): void {
    this.handlers.push(handler);
  }

  unsubscribe(handler: PriceHandler): void {
    const index = this.handlers.indexOf(handler);
    if (index > -1) {
      this.handlers.splice(index, 1);
    }
  }

  private emit(update: PriceUpdate): void {
    this.lastPrices.set(update.symbol, update);
    for (const handler of this.handlers) {
      try {
        handler(update);
      } catch (err) {
        logger.error("BinanceFeed", "Handler error", err);
      }
    }
  }

  getLastPrice(symbol: "BTC" | "ETH"): PriceUpdate | undefined {
    return this.lastPrices.get(symbol);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn("BinanceFeed", "Already running");
      return;
    }

    this.isRunning = true;
    await this.connect();
  }

  private async connect(): Promise<void> {
    const streams = this.symbols
      .map((s) => {
        const pair = s === "BTC" ? "btcusdt" : "ethusdt";
        return `${pair}@bookTicker`;
      })
      .join("/");

    const url = `${BINANCE_WS_URL}/${streams}`;

    logger.info("BinanceFeed", `Connecting to ${url}`);

    this.ws = new WebSocket(url);

    this.ws.on("open", () => {
      logger.info("BinanceFeed", "Connected to Binance WebSocket");
      this.reconnectAttempts = 0;
    });

    this.ws.on("message", (data: WebSocket.Data) => {
      try {
        const message = JSON.parse(data.toString()) as BinanceBookTickerMessage;
        this.handleMessage(message);
      } catch (err) {
        logger.error("BinanceFeed", "Failed to parse message", err);
      }
    });

    this.ws.on("error", (err) => {
      logger.error("BinanceFeed", "WebSocket error", err);
    });

    this.ws.on("close", () => {
      logger.warn("BinanceFeed", "WebSocket closed");
      if (this.isRunning) {
        this.scheduleReconnect();
      }
    });
  }

  private handleMessage(message: BinanceBookTickerMessage): void {
    const symbol = message.s.startsWith("BTC") ? "BTC" : "ETH";
    const midPrice = new Decimal(message.b).plus(message.a).div(2);

    const update: PriceUpdate = {
      symbol: symbol as "BTC" | "ETH",
      price: midPrice,
      timestamp: Date.now(),
      source: "binance",
    };

    this.emit(update);
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error("BinanceFeed", "Max reconnect attempts reached");
      this.isRunning = false;
      return;
    }

    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    logger.info(
      "BinanceFeed",
      `Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`
    );

    setTimeout(() => {
      if (this.isRunning) {
        this.connect();
      }
    }, delay);
  }

  stop(): void {
    this.isRunning = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    logger.info("BinanceFeed", "Stopped");
  }
}
