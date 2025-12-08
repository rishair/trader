import { spawn, ChildProcess } from "child_process";
import path from "path";
import {
  addMessage,
  markConversationStarted,
  updateConversationTitle,
} from "./db.server.js";

const PROJECT_ROOT = path.resolve(process.cwd(), "..");

// Track active processes
const activeProcesses = new Map<string, ChildProcess>();

export interface StreamEvent {
  type: "chunk" | "complete" | "error" | "tool_use" | "tool_result" | "system";
  content?: string;
  toolName?: string;
  toolId?: string;
  toolInput?: Record<string, unknown>;
  messageId?: string;
  sessionId?: string;
  costUsd?: number;
  durationMs?: number;
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

  // Skip permissions for automation
  claudeArgs.push("--dangerously-skip-permissions");

  return new Promise((resolve) => {
    const claude = spawn("claude", claudeArgs, {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    activeProcesses.set(conversationId, claude);

    // Track tool calls to build complete response
    const toolCalls: Array<{ name: string; input: Record<string, unknown>; result?: string }> = [];
    let textContent = "";
    let buffer = "";

    claude.stdout?.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          const events = parseClaudeEvent(event, toolCalls);
          for (const parsed of events) {
            if (parsed.type === "chunk" && parsed.content) {
              textContent += parsed.content;
            }
            onEvent(parsed);
          }
        } catch {
          // Non-JSON output - likely a plain text response
          if (line && !line.startsWith("{")) {
            textContent += line + "\n";
            onEvent({ type: "chunk", content: line + "\n" });
          }
        }
      }
    });

    claude.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      // Filter out noise
      if (!text.includes("dotenv") && !text.includes("Warning") && !text.includes("ExperimentalWarning")) {
        console.error(`[Claude stderr] ${text}`);
      }
    });

    claude.on("close", (code) => {
      activeProcesses.delete(conversationId);

      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          const events = parseClaudeEvent(event, toolCalls);
          for (const parsed of events) {
            if (parsed.type === "chunk" && parsed.content) {
              textContent += parsed.content;
            }
            onEvent(parsed);
          }
        } catch {
          if (buffer && !buffer.startsWith("{")) {
            textContent += buffer;
          }
        }
      }

      // Build full response including tool calls
      const fullResponse = buildFullResponse(textContent, toolCalls);

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

function parseClaudeEvent(
  event: any,
  toolCalls: Array<{ name: string; input: Record<string, unknown>; result?: string }>
): StreamEvent[] {
  const events: StreamEvent[] = [];

  // Handle system init event
  if (event.type === "system" && event.subtype === "init") {
    events.push({
      type: "system",
      sessionId: event.session_id,
      content: `Session started (model: ${event.model || "unknown"})`,
    });
    return events;
  }

  // Handle assistant message content
  if (event.type === "assistant" && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === "text" && block.text) {
        events.push({ type: "chunk", content: block.text });
      }
      if (block.type === "tool_use") {
        // Track this tool call
        toolCalls.push({
          name: block.name,
          input: block.input || {},
        });
        events.push({
          type: "tool_use",
          toolName: block.name,
          toolId: block.id,
          toolInput: block.input,
        });
      }
    }
    return events;
  }

  // Handle tool result (user message with tool_result)
  if (event.type === "user" && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === "tool_result") {
        // Find the matching tool call and add the result
        const lastToolWithoutResult = toolCalls.find(t => !t.result);
        if (lastToolWithoutResult) {
          lastToolWithoutResult.result = typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content);
        }

        // Truncate long results for display
        const displayContent = typeof block.content === 'string'
          ? block.content
          : JSON.stringify(block.content);
        const truncated = displayContent.length > 500
          ? displayContent.slice(0, 500) + "..."
          : displayContent;

        events.push({
          type: "tool_result",
          toolId: block.tool_use_id,
          content: truncated,
        });
      }
    }
    return events;
  }

  // Handle final result event
  if (event.type === "result") {
    events.push({
      type: "system",
      content: `Completed (${event.subtype || "success"})`,
      costUsd: event.cost_usd,
      durationMs: event.duration_ms,
    });
    return events;
  }

  return events;
}

function buildFullResponse(
  textContent: string,
  toolCalls: Array<{ name: string; input: Record<string, unknown>; result?: string }>
): string {
  // If there are no tool calls, just return the text content
  if (toolCalls.length === 0) {
    return textContent;
  }

  // Build a response that includes tool call information
  let response = textContent;

  // Add tool call summary if there were any
  if (toolCalls.length > 0) {
    const toolSummary = toolCalls
      .map((t, i) => {
        const inputPreview = JSON.stringify(t.input).slice(0, 100);
        const resultPreview = t.result ? t.result.slice(0, 200) : "no result";
        return `${i + 1}. **${t.name}**: ${inputPreview}${inputPreview.length >= 100 ? "..." : ""}\n   → ${resultPreview}${(t.result?.length || 0) > 200 ? "..." : ""}`;
      })
      .join("\n");

    if (response) {
      response += "\n\n---\n**Tool calls:**\n" + toolSummary;
    } else {
      response = "**Tool calls:**\n" + toolSummary;
    }
  }

  return response;
}

export function cancelStream(conversationId: string): void {
  const process = activeProcesses.get(conversationId);
  if (process) {
    process.kill("SIGTERM");
    activeProcesses.delete(conversationId);
  }
}
