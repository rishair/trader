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
