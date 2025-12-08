import fs from "fs";
import path from "path";

export interface Agent {
  id: string;
  name: string;
  description: string;
}

const AGENTS_DIR = path.resolve(process.cwd(), "..", ".claude", "agents");

const AGENT_METADATA: Record<string, { name: string; description: string }> = {
  "trade-research": {
    name: "Trade Research Engineer",
    description: "Market analysis, hypotheses, and trading strategies",
  },
  "agent-engineer": {
    name: "Agent Engineer",
    description: "System improvements, tools, and infrastructure",
  },
  "hypothesis-tester": {
    name: "Hypothesis Tester",
    description: "Test and validate trading hypotheses",
  },
  "market-watcher": {
    name: "Market Watcher",
    description: "Monitor market conditions and prices",
  },
  researcher: {
    name: "Researcher",
    description: "Deep research on topics and markets",
  },
  resourcer: {
    name: "Resourcer",
    description: "Manage and organize resources",
  },
  "self-improver": {
    name: "Self Improver",
    description: "Identify and implement system improvements",
  },
  "strategy-tester": {
    name: "Strategy Tester",
    description: "Backtest and validate strategies",
  },
  "tool-builder": {
    name: "Tool Builder",
    description: "Create new tools and capabilities",
  },
  "trade-executor": {
    name: "Trade Executor",
    description: "Execute trades and manage positions",
  },
};

export function getAvailableAgents(): Agent[] {
  try {
    const files = fs.readdirSync(AGENTS_DIR);
    const agentFiles = files.filter((f) => f.endsWith(".md"));

    return agentFiles
      .map((f) => {
        const id = f.replace(".md", "");
        const meta = AGENT_METADATA[id];
        if (!meta) return null;
        return { id, ...meta };
      })
      .filter((a): a is Agent => a !== null);
  } catch {
    // Return default agents if directory doesn't exist
    return Object.entries(AGENT_METADATA).map(([id, meta]) => ({
      id,
      ...meta,
    }));
  }
}

export function getAgentById(id: string): Agent | null {
  const meta = AGENT_METADATA[id];
  if (!meta) return null;
  return { id, ...meta };
}
