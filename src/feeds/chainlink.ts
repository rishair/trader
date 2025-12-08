import { ethers } from "ethers";
import Decimal from "decimal.js";
import { logger } from "../utils/logger.js";
import type { PriceUpdate, PriceHandler } from "../types/index.js";

// Chainlink Aggregator V3 Interface ABI (minimal)
const AGGREGATOR_V3_ABI = [
  {
    inputs: [],
    name: "latestRoundData",
    outputs: [
      { internalType: "uint80", name: "roundId", type: "uint80" },
      { internalType: "int256", name: "answer", type: "int256" },
      { internalType: "uint256", name: "startedAt", type: "uint256" },
      { internalType: "uint256", name: "updatedAt", type: "uint256" },
      { internalType: "uint80", name: "answeredInRound", type: "uint80" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
];

// Polygon Mainnet Chainlink Price Feed Addresses
const CHAINLINK_FEEDS: Record<"BTC" | "ETH", string> = {
  BTC: "0xc907E116054Ad103354f2D350FD2514433D57F6f", // BTC/USD on Polygon
  ETH: "0xF9680D99D6C9589e2a93a78A04A279e509205945", // ETH/USD on Polygon
};

interface ChainlinkRoundData {
  roundId: bigint;
  answer: bigint;
  startedAt: bigint;
  updatedAt: bigint;
  answeredInRound: bigint;
}

export class ChainlinkFeed {
  private provider: ethers.JsonRpcProvider;
  private contracts: Map<"BTC" | "ETH", ethers.Contract> = new Map();
  private decimals: Map<"BTC" | "ETH", number> = new Map();
  private handlers: PriceHandler[] = [];
  private pollInterval: NodeJS.Timeout | null = null;
  private isRunning = false;
  private lastPrices: Map<string, PriceUpdate> = new Map();
  private lastRoundIds: Map<"BTC" | "ETH", bigint> = new Map();

  constructor(
    private rpcUrl: string,
    private symbols: ("BTC" | "ETH")[],
    private pollMs: number = 1000 // Poll every 1 second
  ) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
  }

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
        logger.error("ChainlinkFeed", "Handler error", err);
      }
    }
  }

  getLastPrice(symbol: "BTC" | "ETH"): PriceUpdate | undefined {
    return this.lastPrices.get(symbol);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn("ChainlinkFeed", "Already running");
      return;
    }

    logger.info("ChainlinkFeed", "Initializing contracts...");

    // Initialize contracts and get decimals
    for (const symbol of this.symbols) {
      const address = CHAINLINK_FEEDS[symbol];
      const contract = new ethers.Contract(
        address,
        AGGREGATOR_V3_ABI,
        this.provider
      );
      this.contracts.set(symbol, contract);

      const decimals = await contract.decimals();
      this.decimals.set(symbol, Number(decimals));
      logger.info(
        "ChainlinkFeed",
        `${symbol}/USD feed initialized (${decimals} decimals)`
      );
    }

    this.isRunning = true;

    // Initial fetch
    await this.fetchAllPrices();

    // Start polling
    this.pollInterval = setInterval(() => {
      this.fetchAllPrices().catch((err) => {
        logger.error("ChainlinkFeed", "Poll error", err);
      });
    }, this.pollMs);

    logger.info("ChainlinkFeed", `Started polling every ${this.pollMs}ms`);
  }

  private async fetchAllPrices(): Promise<void> {
    const promises = this.symbols.map((symbol) => this.fetchPrice(symbol));
    await Promise.all(promises);
  }

  private async fetchPrice(symbol: "BTC" | "ETH"): Promise<void> {
    const contract = this.contracts.get(symbol);
    const decimals = this.decimals.get(symbol);

    if (!contract || decimals === undefined) {
      logger.error("ChainlinkFeed", `Contract not initialized for ${symbol}`);
      return;
    }

    try {
      const roundData: ChainlinkRoundData = await contract.latestRoundData();

      // Only emit if this is a new round (price update)
      const lastRoundId = this.lastRoundIds.get(symbol);
      if (lastRoundId !== undefined && roundData.roundId === lastRoundId) {
        return; // No new data
      }

      this.lastRoundIds.set(symbol, roundData.roundId);

      const price = new Decimal(roundData.answer.toString()).div(
        new Decimal(10).pow(decimals)
      );

      const update: PriceUpdate = {
        symbol,
        price,
        timestamp: Number(roundData.updatedAt) * 1000, // Convert to ms
        source: "chainlink",
      };

      this.emit(update);

      logger.debug(
        "ChainlinkFeed",
        `${symbol}: $${price.toFixed(2)} (round ${roundData.roundId})`
      );
    } catch (err) {
      logger.error("ChainlinkFeed", `Failed to fetch ${symbol} price`, err);
    }
  }

  stop(): void {
    this.isRunning = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    logger.info("ChainlinkFeed", "Stopped");
  }
}
