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
