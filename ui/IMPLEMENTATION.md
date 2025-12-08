# Web UI Implementation Guide

A step-by-step guide to build the Trader Bot web UI with Remix.

## Prerequisites

```bash
cd /Users/rishair/projects/trader
```

---

## Step 1: Initialize Remix Project

```bash
# Create the ui directory and initialize Remix
mkdir -p ui
cd ui

# Initialize package.json
cat > package.json << 'EOF'
{
  "name": "trader-ui",
  "private": true,
  "sideEffects": false,
  "type": "module",
  "scripts": {
    "build": "remix vite:build",
    "dev": "node ./server.js",
    "start": "NODE_ENV=production node ./server.js",
    "typecheck": "tsc"
  },
  "dependencies": {
    "@remix-run/express": "^2.15.0",
    "@remix-run/node": "^2.15.0",
    "@remix-run/react": "^2.15.0",
    "better-sqlite3": "^11.6.0",
    "compression": "^1.7.4",
    "express": "^4.21.0",
    "isbot": "^4.4.0",
    "morgan": "^1.10.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-markdown": "^9.0.1",
    "uuid": "^11.0.3",
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@remix-run/dev": "^2.15.0",
    "@types/better-sqlite3": "^7.6.11",
    "@types/compression": "^1.7.5",
    "@types/express": "^5.0.0",
    "@types/morgan": "^1.9.9",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@types/uuid": "^10.0.0",
    "@types/ws": "^8.5.13",
    "autoprefixer": "^10.4.20",
    "postcss": "^8.4.49",
    "tailwindcss": "^3.4.15",
    "typescript": "^5.6.3",
    "vite": "^5.4.11",
    "vite-tsconfig-paths": "^5.1.3"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
EOF

# Install dependencies
npm install
```

---

## Step 2: Create Configuration Files

### tsconfig.json
```bash
cat > tsconfig.json << 'EOF'
{
  "include": [
    "**/*.ts",
    "**/*.tsx",
    "**/.server/**/*.ts",
    "**/.server/**/*.tsx",
    "**/.client/**/*.ts",
    "**/.client/**/*.tsx"
  ],
  "compilerOptions": {
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "types": ["node", "vite/client"],
    "isolatedModules": true,
    "esModuleInterop": true,
    "jsx": "react-jsx",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "target": "ES2022",
    "strict": true,
    "allowJs": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "baseUrl": ".",
    "paths": {
      "~/*": ["./app/*"]
    },
    "noEmit": true
  }
}
EOF
```

### vite.config.ts
```bash
cat > vite.config.ts << 'EOF'
import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

declare module "@remix-run/node" {
  interface Future {
    v3_singleFetch: true;
  }
}

export default defineConfig({
  plugins: [
    remix({
      future: {
        v3_fetcherPersist: true,
        v3_relativeSplatPath: true,
        v3_throwAbortReason: true,
        v3_singleFetch: true,
        v3_lazyRouteDiscovery: true,
      },
    }),
    tsconfigPaths(),
  ],
});
EOF
```

### tailwind.config.ts
```bash
cat > tailwind.config.ts << 'EOF'
import type { Config } from "tailwindcss";

export default {
  content: ["./app/**/{**,.client,.server}/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {},
  },
  plugins: [],
} satisfies Config;
EOF
```

### postcss.config.js
```bash
cat > postcss.config.js << 'EOF'
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
EOF
```

---

## Step 3: Create Server Entry (server.js)

```bash
cat > server.js << 'EOF'
import { createRequestHandler } from "@remix-run/express";
import compression from "compression";
import express from "express";
import morgan from "morgan";
import { WebSocketServer } from "ws";
import { createServer } from "http";

const viteDevServer =
  process.env.NODE_ENV === "production"
    ? undefined
    : await import("vite").then((vite) =>
        vite.createServer({
          server: { middlewareMode: true },
        })
      );

const remixHandler = createRequestHandler({
  build: viteDevServer
    ? () => viteDevServer.ssrLoadModule("virtual:remix/server-build")
    : await import("./build/server/index.js"),
});

const app = express();
const server = createServer(app);

// WebSocket server
const wss = new WebSocketServer({ server, path: "/ws" });

// Store active connections and their subscriptions
const connections = new Map();

wss.on("connection", (ws) => {
  const connectionId = Math.random().toString(36).substring(7);
  connections.set(connectionId, { ws, conversationId: null });

  ws.on("message", async (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === "subscribe") {
        const conn = connections.get(connectionId);
        if (conn) {
          conn.conversationId = msg.conversationId;
        }
      }

      if (msg.type === "message:send") {
        // Import claude service dynamically to avoid issues during build
        const { sendMessageToClaude } = await import("./app/lib/claude.server.js");
        await sendMessageToClaude(
          msg.conversationId,
          msg.content,
          msg.agent,
          msg.isFirstMessage,
          (event) => {
            // Broadcast to all clients subscribed to this conversation
            for (const [, conn] of connections) {
              if (conn.conversationId === msg.conversationId && conn.ws.readyState === 1) {
                conn.ws.send(JSON.stringify(event));
              }
            }
          }
        );
      }
    } catch (err) {
      console.error("WebSocket error:", err);
      ws.send(JSON.stringify({ type: "error", error: err.message }));
    }
  });

  ws.on("close", () => {
    connections.delete(connectionId);
  });
});

app.use(compression());

// http://expressjs.com/en/advanced/best-practice-security.html#at-a-minimum-disable-x-powered-by-header
app.disable("x-powered-by");

// handle asset requests
if (viteDevServer) {
  app.use(viteDevServer.middlewares);
} else {
  // Vite fingerprints its assets so we can cache forever.
  app.use(
    "/assets",
    express.static("build/client/assets", { immutable: true, maxAge: "1y" })
  );
}

// Everything else (like favicon.ico) is cached for an hour. You may want to be
// more aggressive with this caching.
app.use(express.static("build/client", { maxAge: "1h" }));

app.use(morgan("tiny"));

// handle SSR requests
app.all("*", remixHandler);

const port = process.env.PORT || 3000;
server.listen(port, () =>
  console.log(`Express server listening at http://localhost:${port}`)
);
EOF
```

---

## Step 4: Create Database Schema and Service

### db/schema.sql
```bash
mkdir -p db
cat > db/schema.sql << 'EOF'
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  agent TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  message_count INTEGER DEFAULT 0,
  claude_session_started INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
EOF
```

### app/lib/db.server.ts
```bash
mkdir -p app/lib
cat > app/lib/db.server.ts << 'EOF'
import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";

const DB_PATH = path.join(process.cwd(), "db", "trader-ui.db");
const SCHEMA_PATH = path.join(process.cwd(), "db", "schema.sql");

// Ensure db directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// Initialize schema
const schema = fs.readFileSync(SCHEMA_PATH, "utf-8");
db.exec(schema);

export interface Conversation {
  id: string;
  title: string;
  agent: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  claudeSessionStarted: boolean;
}

export interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

// Conversation operations
export function getAllConversations(): Conversation[] {
  const rows = db
    .prepare(
      `SELECT id, title, agent, created_at, updated_at, message_count, claude_session_started
       FROM conversations ORDER BY updated_at DESC`
    )
    .all() as any[];

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    agent: row.agent,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count,
    claudeSessionStarted: Boolean(row.claude_session_started),
  }));
}

export function getConversation(id: string): Conversation | null {
  const row = db
    .prepare(
      `SELECT id, title, agent, created_at, updated_at, message_count, claude_session_started
       FROM conversations WHERE id = ?`
    )
    .get(id) as any;

  if (!row) return null;

  return {
    id: row.id,
    title: row.title,
    agent: row.agent,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count,
    claudeSessionStarted: Boolean(row.claude_session_started),
  };
}

export function createConversation(agent: string, title?: string): Conversation {
  const id = uuidv4();
  const now = new Date().toISOString();
  const conversationTitle = title || "New conversation";

  db.prepare(
    `INSERT INTO conversations (id, title, agent, created_at, updated_at, message_count, claude_session_started)
     VALUES (?, ?, ?, ?, ?, 0, 0)`
  ).run(id, conversationTitle, agent, now, now);

  return {
    id,
    title: conversationTitle,
    agent,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    claudeSessionStarted: false,
  };
}

export function updateConversationTitle(id: string, title: string): void {
  db.prepare(`UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`).run(
    title,
    new Date().toISOString(),
    id
  );
}

export function markConversationStarted(id: string): void {
  db.prepare(
    `UPDATE conversations SET claude_session_started = 1, updated_at = ? WHERE id = ?`
  ).run(new Date().toISOString(), id);
}

export function deleteConversation(id: string): void {
  db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
}

// Message operations
export function getMessages(conversationId: string): Message[] {
  const rows = db
    .prepare(
      `SELECT id, conversation_id, role, content, created_at
       FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`
    )
    .all(conversationId) as any[];

  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  }));
}

export function addMessage(
  conversationId: string,
  role: "user" | "assistant",
  content: string
): Message {
  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, conversationId, role, content, now);

  // Update conversation
  db.prepare(
    `UPDATE conversations
     SET message_count = message_count + 1, updated_at = ?
     WHERE id = ?`
  ).run(now, conversationId);

  return {
    id,
    conversationId,
    role,
    content,
    createdAt: now,
  };
}

export { db };
EOF
```

---

## Step 5: Create Agent Service

### app/lib/agents.server.ts
```bash
cat > app/lib/agents.server.ts << 'EOF'
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
EOF
```

---

## Step 6: Create Claude Service

### app/lib/claude.server.ts
```bash
cat > app/lib/claude.server.ts << 'EOF'
import { spawn, ChildProcess } from "child_process";
import path from "path";
import {
  addMessage,
  markConversationStarted,
  updateConversationTitle,
  getConversation,
} from "./db.server.js";

const PROJECT_ROOT = path.resolve(process.cwd(), "..");

// Track active processes
const activeProcesses = new Map<string, ChildProcess>();

export interface StreamEvent {
  type: "chunk" | "complete" | "error" | "tool_use";
  content?: string;
  toolName?: string;
  messageId?: string;
}

type EventCallback = (event: StreamEvent) => void;

export async function sendMessageToClaude(
  conversationId: string,
  content: string,
  agent: string,
  isFirstMessage: boolean,
  onEvent: EventCallback
): Promise<void> {
  // Save user message to DB
  addMessage(conversationId, "user", content);

  // Auto-generate title from first message
  if (isFirstMessage) {
    const title = content.slice(0, 50) + (content.length > 50 ? "..." : "");
    updateConversationTitle(conversationId, title);
  }

  // Build Claude CLI arguments
  const claudeArgs: string[] = [];

  // Session management
  if (isFirstMessage) {
    claudeArgs.push("--session-id", conversationId);
  } else {
    claudeArgs.push("--resume", conversationId);
  }

  // Add the prompt
  claudeArgs.push("-p", content);

  // Output format for streaming
  claudeArgs.push("--output-format", "stream-json");
  claudeArgs.push("--verbose");

  // Skip permissions for automation
  claudeArgs.push("--dangerously-skip-permissions");

  return new Promise((resolve) => {
    const claude = spawn("claude", claudeArgs, {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    activeProcesses.set(conversationId, claude);

    let fullResponse = "";
    let buffer = "";

    claude.stdout?.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          const parsed = parseClaudeEvent(event);
          if (parsed) {
            if (parsed.type === "chunk" && parsed.content) {
              fullResponse += parsed.content;
            }
            onEvent(parsed);
          }
        } catch {
          // Non-JSON output
          if (line && !line.startsWith("{")) {
            fullResponse += line + "\n";
            onEvent({ type: "chunk", content: line + "\n" });
          }
        }
      }
    });

    claude.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      // Filter out noise
      if (!text.includes("dotenv") && !text.includes("Warning")) {
        console.error(`[Claude stderr] ${text}`);
      }
    });

    claude.on("close", (code) => {
      activeProcesses.delete(conversationId);

      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          const parsed = parseClaudeEvent(event);
          if (parsed) {
            if (parsed.type === "chunk" && parsed.content) {
              fullResponse += parsed.content;
            }
            onEvent(parsed);
          }
        } catch {
          fullResponse += buffer;
        }
      }

      // Save assistant message to DB
      if (fullResponse.trim()) {
        const message = addMessage(conversationId, "assistant", fullResponse.trim());

        // Mark session as started
        if (isFirstMessage) {
          markConversationStarted(conversationId);
        }

        onEvent({ type: "complete", messageId: message.id });
      } else {
        onEvent({ type: "complete" });
      }

      resolve();
    });

    claude.on("error", (err) => {
      activeProcesses.delete(conversationId);
      onEvent({ type: "error", content: err.message });
      resolve();
    });
  });
}

function parseClaudeEvent(event: any): StreamEvent | null {
  // Handle assistant message content
  if (event.type === "assistant" && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === "text" && block.text) {
        return { type: "chunk", content: block.text };
      }
      if (block.type === "tool_use") {
        return { type: "tool_use", toolName: block.name };
      }
    }
  }

  // Handle content block deltas (streaming)
  if (event.type === "content_block_delta" && event.delta?.text) {
    return { type: "chunk", content: event.delta.text };
  }

  // Handle result
  if (event.type === "result" && event.result) {
    return { type: "chunk", content: event.result };
  }

  return null;
}

export function cancelStream(conversationId: string): void {
  const process = activeProcesses.get(conversationId);
  if (process) {
    process.kill("SIGTERM");
    activeProcesses.delete(conversationId);
  }
}
EOF
```

---

## Step 7: Create Types

### app/types.ts
```bash
cat > app/types.ts << 'EOF'
export interface Conversation {
  id: string;
  title: string;
  agent: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  claudeSessionStarted: boolean;
}

export interface Message {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface Agent {
  id: string;
  name: string;
  description: string;
}

// WebSocket message types
export interface WsMessageSend {
  type: "message:send";
  conversationId: string;
  content: string;
  agent: string;
  isFirstMessage: boolean;
}

export interface WsSubscribe {
  type: "subscribe";
  conversationId: string;
}

export interface WsChunk {
  type: "chunk";
  content?: string;
  toolName?: string;
}

export interface WsComplete {
  type: "complete";
  messageId?: string;
}

export interface WsError {
  type: "error";
  content?: string;
}

export type WsIncoming = WsMessageSend | WsSubscribe;
export type WsOutgoing = WsChunk | WsComplete | WsError;
EOF
```

---

## Step 8: Create App Shell and Styles

### app/root.tsx
```bash
cat > app/root.tsx << 'EOF'
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "@remix-run/react";
import type { LinksFunction } from "@remix-run/node";

import "./tailwind.css";

export const links: LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
  },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body className="h-full bg-gray-900 text-gray-100 font-sans">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}
EOF
```

### app/tailwind.css
```bash
cat > app/tailwind.css << 'EOF'
@tailwind base;
@tailwind components;
@tailwind utilities;

body {
  font-family: "Inter", system-ui, sans-serif;
}

/* Custom scrollbar for dark theme */
::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

::-webkit-scrollbar-track {
  background: #1f2937;
}

::-webkit-scrollbar-thumb {
  background: #4b5563;
  border-radius: 4px;
}

::-webkit-scrollbar-thumb:hover {
  background: #6b7280;
}

/* Markdown content styling */
.prose-invert pre {
  background-color: #1f2937;
  padding: 1rem;
  border-radius: 0.5rem;
  overflow-x: auto;
}

.prose-invert code {
  background-color: #374151;
  padding: 0.125rem 0.25rem;
  border-radius: 0.25rem;
  font-size: 0.875em;
}

.prose-invert pre code {
  background-color: transparent;
  padding: 0;
}
EOF
```

---

## Step 9: Create Routes

### app/routes/_index.tsx
```bash
mkdir -p app/routes
cat > app/routes/_index.tsx << 'EOF'
import { redirect } from "@remix-run/node";

export const loader = () => redirect("/chat");
EOF
```

### app/routes/chat.tsx (Layout)
```bash
cat > app/routes/chat.tsx << 'EOF'
import { json } from "@remix-run/node";
import { Outlet, useLoaderData, Link, useParams } from "@remix-run/react";
import { getAllConversations } from "~/lib/db.server";
import { getAvailableAgents } from "~/lib/agents.server";
import { Sidebar } from "~/components/Sidebar";

export const loader = async () => {
  const conversations = getAllConversations();
  const agents = getAvailableAgents();
  return json({ conversations, agents });
};

export default function ChatLayout() {
  const { conversations, agents } = useLoaderData<typeof loader>();
  const params = useParams();

  return (
    <div className="flex h-screen">
      <Sidebar
        conversations={conversations}
        currentId={params.id}
        agents={agents}
      />
      <main className="flex-1 flex flex-col">
        <Outlet context={{ agents }} />
      </main>
    </div>
  );
}
EOF
```

### app/routes/chat._index.tsx (Empty state)
```bash
cat > app/routes/chat._index.tsx << 'EOF'
import { useOutletContext } from "@remix-run/react";
import type { Agent } from "~/types";

export default function ChatIndex() {
  const { agents } = useOutletContext<{ agents: Agent[] }>();

  return (
    <div className="flex-1 flex items-center justify-center text-gray-500">
      <div className="text-center">
        <h2 className="text-xl font-medium mb-2">Welcome to Trader Bot</h2>
        <p className="mb-4">Select a conversation or start a new one</p>
        <a
          href="/chat/new"
          className="inline-block px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg"
        >
          + New Chat
        </a>
      </div>
    </div>
  );
}
EOF
```

### app/routes/chat.new.tsx
```bash
cat > app/routes/chat.new.tsx << 'EOF'
import { json, redirect } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { Form, useOutletContext, useNavigation } from "@remix-run/react";
import { createConversation } from "~/lib/db.server";
import type { Agent } from "~/types";
import { useState } from "react";

export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const agent = formData.get("agent") as string;

  if (!agent) {
    return json({ error: "Agent is required" }, { status: 400 });
  }

  const conversation = createConversation(agent);
  return redirect(`/chat/${conversation.id}`);
};

export default function NewChat() {
  const { agents } = useOutletContext<{ agents: Agent[] }>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const [selectedAgent, setSelectedAgent] = useState(agents[0]?.id || "trade-research");

  const selectedAgentInfo = agents.find((a) => a.id === selectedAgent);

  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="w-full max-w-md p-6">
        <h2 className="text-2xl font-semibold mb-6 text-center">Start New Chat</h2>

        <Form method="post" className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Select Agent
            </label>
            <select
              name="agent"
              value={selectedAgent}
              onChange={(e) => setSelectedAgent(e.target.value)}
              className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg focus:outline-none focus:border-blue-500"
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
            {selectedAgentInfo && (
              <p className="mt-2 text-sm text-gray-400">
                {selectedAgentInfo.description}
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
          >
            {isSubmitting ? "Creating..." : "Start Conversation"}
          </button>
        </Form>
      </div>
    </div>
  );
}
EOF
```

### app/routes/chat.$id.tsx
```bash
cat > 'app/routes/chat.$id.tsx' << 'EOF'
import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useOutletContext } from "@remix-run/react";
import { getConversation, getMessages } from "~/lib/db.server";
import { ChatArea } from "~/components/ChatArea";
import { MessageInput } from "~/components/MessageInput";
import type { Agent } from "~/types";
import { useWebSocket } from "~/hooks/useWebSocket";
import { useState, useEffect, useRef } from "react";

export const loader = async ({ params }: LoaderFunctionArgs) => {
  const conversation = getConversation(params.id!);
  if (!conversation) {
    throw new Response("Conversation not found", { status: 404 });
  }

  const messages = getMessages(params.id!);
  return json({ conversation, messages });
};

export default function ChatConversation() {
  const { conversation, messages: initialMessages } = useLoaderData<typeof loader>();
  const { agents } = useOutletContext<{ agents: Agent[] }>();
  const [messages, setMessages] = useState(initialMessages);
  const [streamingContent, setStreamingContent] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Reset state when conversation changes
  useEffect(() => {
    setMessages(initialMessages);
    setStreamingContent("");
    setIsLoading(false);
  }, [conversation.id, initialMessages]);

  const { sendMessage, isConnected } = useWebSocket({
    conversationId: conversation.id,
    onChunk: (content) => {
      setStreamingContent((prev) => prev + content);
    },
    onComplete: (messageId) => {
      // Add the completed message to the list
      if (streamingContent) {
        setMessages((prev) => [
          ...prev,
          {
            id: messageId || `temp-${Date.now()}`,
            conversationId: conversation.id,
            role: "assistant" as const,
            content: streamingContent,
            createdAt: new Date().toISOString(),
          },
        ]);
      }
      setStreamingContent("");
      setIsLoading(false);
    },
    onError: (error) => {
      console.error("WebSocket error:", error);
      setIsLoading(false);
    },
  });

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  const handleSendMessage = (content: string) => {
    // Add user message to local state immediately
    const userMessage = {
      id: `temp-user-${Date.now()}`,
      conversationId: conversation.id,
      role: "user" as const,
      content,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMessage]);
    setIsLoading(true);
    setStreamingContent("");

    // Send via WebSocket
    sendMessage(content, conversation.agent, !conversation.claudeSessionStarted && messages.length === 0);
  };

  const agent = agents.find((a) => a.id === conversation.agent);

  return (
    <>
      {/* Header */}
      <div className="border-b border-gray-700 px-6 py-4">
        <h1 className="text-lg font-medium truncate">{conversation.title}</h1>
        {agent && (
          <p className="text-sm text-gray-400">{agent.name}</p>
        )}
      </div>

      {/* Messages */}
      <ChatArea
        messages={messages}
        streamingContent={streamingContent}
        isLoading={isLoading}
      />
      <div ref={messagesEndRef} />

      {/* Input */}
      <MessageInput
        onSend={handleSendMessage}
        disabled={isLoading || !isConnected}
        placeholder={isConnected ? "Type your message..." : "Connecting..."}
      />
    </>
  );
}
EOF
```

---

## Step 10: Create Components

### app/components/Sidebar.tsx
```bash
mkdir -p app/components
cat > app/components/Sidebar.tsx << 'EOF'
import { Link } from "@remix-run/react";
import type { Conversation, Agent } from "~/types";

interface SidebarProps {
  conversations: Conversation[];
  currentId?: string;
  agents: Agent[];
}

function groupConversationsByDate(conversations: Conversation[]) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const lastWeek = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

  const groups: { label: string; items: Conversation[] }[] = [
    { label: "Today", items: [] },
    { label: "Yesterday", items: [] },
    { label: "Last 7 Days", items: [] },
    { label: "Older", items: [] },
  ];

  conversations.forEach((conv) => {
    const date = new Date(conv.updatedAt);
    if (date >= today) {
      groups[0].items.push(conv);
    } else if (date >= yesterday) {
      groups[1].items.push(conv);
    } else if (date >= lastWeek) {
      groups[2].items.push(conv);
    } else {
      groups[3].items.push(conv);
    }
  });

  return groups.filter((g) => g.items.length > 0);
}

export function Sidebar({ conversations, currentId, agents }: SidebarProps) {
  const groups = groupConversationsByDate(conversations);
  const getAgentName = (agentId: string) =>
    agents.find((a) => a.id === agentId)?.name || agentId;

  return (
    <aside className="w-64 bg-gray-800 border-r border-gray-700 flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-gray-700">
        <Link
          to="/chat/new"
          className="block w-full py-2 px-4 bg-blue-600 hover:bg-blue-700 rounded-lg font-medium text-center transition-colors"
        >
          + New Chat
        </Link>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto p-2">
        {groups.map((group) => (
          <div key={group.label} className="mb-4">
            <h3 className="text-xs text-gray-500 uppercase px-2 mb-1 font-medium">
              {group.label}
            </h3>
            {group.items.map((conv) => (
              <Link
                key={conv.id}
                to={`/chat/${conv.id}`}
                className={`block w-full text-left p-2 rounded-lg mb-1 transition-colors ${
                  currentId === conv.id
                    ? "bg-gray-700"
                    : "hover:bg-gray-700/50"
                }`}
              >
                <div className="truncate text-sm">{conv.title}</div>
                <div className="text-xs text-gray-500 truncate">
                  {getAgentName(conv.agent)}
                </div>
              </Link>
            ))}
          </div>
        ))}

        {conversations.length === 0 && (
          <div className="text-center text-gray-500 py-8">
            <p className="text-sm">No conversations yet</p>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-gray-700 text-xs text-gray-500">
        Trader Bot UI
      </div>
    </aside>
  );
}
EOF
```

### app/components/ChatArea.tsx
```bash
cat > app/components/ChatArea.tsx << 'EOF'
import { Message } from "./Message";
import type { Message as MessageType } from "~/types";

interface ChatAreaProps {
  messages: MessageType[];
  streamingContent: string;
  isLoading: boolean;
}

export function ChatArea({ messages, streamingContent, isLoading }: ChatAreaProps) {
  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {messages.length === 0 && !streamingContent && (
        <div className="h-full flex items-center justify-center text-gray-500">
          <p>Send a message to start the conversation</p>
        </div>
      )}

      {messages.map((message) => (
        <Message key={message.id} message={message} />
      ))}

      {/* Streaming message */}
      {streamingContent && (
        <Message
          message={{
            id: "streaming",
            conversationId: "",
            role: "assistant",
            content: streamingContent,
            createdAt: new Date().toISOString(),
          }}
          isStreaming
        />
      )}

      {/* Loading indicator */}
      {isLoading && !streamingContent && (
        <div className="flex justify-start">
          <div className="bg-gray-700 rounded-lg rounded-bl-sm px-4 py-3">
            <div className="flex space-x-1">
              <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
              <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
              <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
EOF
```

### app/components/Message.tsx
```bash
cat > app/components/Message.tsx << 'EOF'
import ReactMarkdown from "react-markdown";
import type { Message as MessageType } from "~/types";

interface MessageProps {
  message: MessageType;
  isStreaming?: boolean;
}

export function Message({ message, isStreaming }: MessageProps) {
  const isUser = message.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-2xl px-4 py-3 rounded-lg ${
          isUser
            ? "bg-blue-600 rounded-br-sm"
            : "bg-gray-700 rounded-bl-sm"
        }`}
      >
        <div className="prose prose-invert prose-sm max-w-none">
          <ReactMarkdown>{message.content}</ReactMarkdown>
        </div>
        {isStreaming && (
          <span className="inline-block w-2 h-4 bg-gray-400 animate-pulse ml-1" />
        )}
      </div>
    </div>
  );
}
EOF
```

### app/components/MessageInput.tsx
```bash
cat > app/components/MessageInput.tsx << 'EOF'
import { useState, useRef, useEffect } from "react";

interface MessageInputProps {
  onSend: (content: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function MessageInput({ onSend, disabled, placeholder }: MessageInputProps) {
  const [message, setMessage] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  }, [message]);

  const handleSubmit = () => {
    if (message.trim() && !disabled) {
      onSend(message.trim());
      setMessage("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="border-t border-gray-700 p-4">
      <div className="flex gap-2 items-end max-w-4xl mx-auto">
        <textarea
          ref={textareaRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder || "Type your message... (Cmd+Enter to send)"}
          disabled={disabled}
          rows={1}
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-4 py-3 resize-none focus:outline-none focus:border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
        />
        <button
          onClick={handleSubmit}
          disabled={disabled || !message.trim()}
          className="px-6 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
        >
          Send
        </button>
      </div>
    </div>
  );
}
EOF
```

---

## Step 11: Create WebSocket Hook

### app/hooks/useWebSocket.ts
```bash
mkdir -p app/hooks
cat > app/hooks/useWebSocket.ts << 'EOF'
import { useEffect, useRef, useState, useCallback } from "react";

interface UseWebSocketOptions {
  conversationId: string;
  onChunk: (content: string) => void;
  onComplete: (messageId?: string) => void;
  onError: (error: string) => void;
}

export function useWebSocket({
  conversationId,
  onChunk,
  onComplete,
  onError,
}: UseWebSocketOptions) {
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout>();

  const connect = useCallback(() => {
    // Clean up existing connection
    if (wsRef.current) {
      wsRef.current.close();
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => {
      setIsConnected(true);
      // Subscribe to this conversation
      ws.send(JSON.stringify({ type: "subscribe", conversationId }));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        switch (data.type) {
          case "chunk":
            if (data.content) {
              onChunk(data.content);
            }
            break;
          case "tool_use":
            onChunk(`\n🔧 Using tool: ${data.toolName}\n`);
            break;
          case "complete":
            onComplete(data.messageId);
            break;
          case "error":
            onError(data.content || "Unknown error");
            break;
        }
      } catch (err) {
        console.error("Failed to parse WebSocket message:", err);
      }
    };

    ws.onclose = () => {
      setIsConnected(false);
      // Attempt to reconnect after 2 seconds
      reconnectTimeoutRef.current = setTimeout(connect, 2000);
    };

    ws.onerror = (error) => {
      console.error("WebSocket error:", error);
    };

    wsRef.current = ws;
  }, [conversationId, onChunk, onComplete, onError]);

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect]);

  // Re-subscribe when conversation changes
  useEffect(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "subscribe", conversationId }));
    }
  }, [conversationId]);

  const sendMessage = useCallback(
    (content: string, agent: string, isFirstMessage: boolean) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
          JSON.stringify({
            type: "message:send",
            conversationId,
            content,
            agent,
            isFirstMessage,
          })
        );
      }
    },
    [conversationId]
  );

  return { sendMessage, isConnected };
}
EOF
```

---

## Step 12: Run and Test

```bash
# From the ui/ directory
npm run dev
```

Open http://localhost:3000 in your browser.

---

## Step 13: Production Deployment

### Build for production
```bash
npm run build
```

### Create systemd service (on server)
```bash
sudo cat > /etc/systemd/system/trader-ui.service << 'EOF'
[Unit]
Description=Trader Bot Web UI
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/trader/ui
Environment=NODE_ENV=production
Environment=PORT=3000
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable trader-ui
sudo systemctl start trader-ui
```

### Update deploy script
Add to `scripts/deploy.sh`:
```bash
# Build and restart UI
cd ui && npm run build && cd ..
ssh root@goodtraderbot.com "cd /opt/trader/ui && npm run build && systemctl restart trader-ui"
```

---

## Troubleshooting

### Database issues
```bash
# Reset database
rm -f db/trader-ui.db
npm run dev  # Will recreate
```

### WebSocket not connecting
- Check that server.js is handling WebSocket upgrades
- Ensure port 3000 is accessible
- Check browser console for connection errors

### Claude CLI not working
- Ensure `claude` is in PATH
- Check that sessions are being created correctly
- Look at server logs for spawn errors

---

## Directory Structure Summary

After completing all steps, your `ui/` folder should look like:

```
ui/
├── app/
│   ├── components/
│   │   ├── ChatArea.tsx
│   │   ├── Message.tsx
│   │   ├── MessageInput.tsx
│   │   └── Sidebar.tsx
│   ├── hooks/
│   │   └── useWebSocket.ts
│   ├── lib/
│   │   ├── agents.server.ts
│   │   ├── claude.server.ts
│   │   └── db.server.ts
│   ├── routes/
│   │   ├── _index.tsx
│   │   ├── chat._index.tsx
│   │   ├── chat.new.tsx
│   │   ├── chat.tsx
│   │   └── chat.$id.tsx
│   ├── root.tsx
│   ├── tailwind.css
│   └── types.ts
├── db/
│   └── schema.sql
├── package.json
├── postcss.config.js
├── server.js
├── tailwind.config.ts
├── tsconfig.json
└── vite.config.ts
```
