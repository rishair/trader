import { useEffect, useRef, useState, useCallback } from "react";

export interface ToolCall {
  id: string;
  name: string;
  input?: Record<string, unknown>;
  result?: string;
  status: "running" | "complete";
}

interface UseWebSocketOptions {
  conversationId: string;
  onChunk: (content: string) => void;
  onToolUse: (tool: ToolCall) => void;
  onToolResult: (toolId: string, result: string) => void;
  onSystem: (message: string, meta?: { costUsd?: number; durationMs?: number }) => void;
  onComplete: (messageId?: string) => void;
  onError: (error: string) => void;
}

export function useWebSocket({
  conversationId,
  onChunk,
  onToolUse,
  onToolResult,
  onSystem,
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
            onToolUse({
              id: data.toolId || `tool-${Date.now()}`,
              name: data.toolName,
              input: data.toolInput,
              status: "running",
            });
            break;
          case "tool_result":
            onToolResult(data.toolId, data.content || "");
            break;
          case "system":
            onSystem(data.content || "", {
              costUsd: data.costUsd,
              durationMs: data.durationMs,
            });
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
  }, [conversationId, onChunk, onToolUse, onToolResult, onSystem, onComplete, onError]);

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
