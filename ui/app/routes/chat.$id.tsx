import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useOutletContext } from "@remix-run/react";
import { getConversation, getMessages } from "~/lib/db.server";
import { ChatArea } from "~/components/ChatArea";
import { MessageInput } from "~/components/MessageInput";
import type { Agent } from "~/types";
import { useWebSocket, type ToolCall } from "~/hooks/useWebSocket";
import { useState, useEffect, useRef, useCallback } from "react";

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
  const [activeTools, setActiveTools] = useState<ToolCall[]>([]);
  const [systemMessage, setSystemMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Use refs to avoid stale closures in callbacks
  const streamingContentRef = useRef(streamingContent);
  const activeToolsRef = useRef(activeTools);

  useEffect(() => {
    streamingContentRef.current = streamingContent;
  }, [streamingContent]);

  useEffect(() => {
    activeToolsRef.current = activeTools;
  }, [activeTools]);

  // Reset state when conversation changes
  useEffect(() => {
    setMessages(initialMessages);
    setStreamingContent("");
    setActiveTools([]);
    setSystemMessage(null);
    setIsLoading(false);
  }, [conversation.id, initialMessages]);

  const handleChunk = useCallback((content: string) => {
    setStreamingContent((prev) => prev + content);
  }, []);

  const handleToolUse = useCallback((tool: ToolCall) => {
    setActiveTools((prev) => [...prev, tool]);
  }, []);

  const handleToolResult = useCallback((toolId: string, result: string) => {
    setActiveTools((prev) =>
      prev.map((t) =>
        t.id === toolId ? { ...t, result, status: "complete" as const } : t
      )
    );
  }, []);

  const handleSystem = useCallback(
    (message: string, meta?: { costUsd?: number; durationMs?: number }) => {
      if (meta?.costUsd !== undefined || meta?.durationMs !== undefined) {
        const parts = [message];
        if (meta.costUsd !== undefined) {
          parts.push(`$${meta.costUsd.toFixed(4)}`);
        }
        if (meta.durationMs !== undefined) {
          parts.push(`${(meta.durationMs / 1000).toFixed(1)}s`);
        }
        setSystemMessage(parts.join(" | "));
      } else {
        setSystemMessage(message);
      }
    },
    []
  );

  const handleComplete = useCallback((messageId?: string) => {
    const currentContent = streamingContentRef.current;
    const currentTools = activeToolsRef.current;

    // Build the complete message content including tool info
    let finalContent = currentContent;

    // If there were tool calls, include them in the message
    if (currentTools.length > 0) {
      const toolSummary = currentTools
        .map((t) => {
          const inputStr = t.input ? JSON.stringify(t.input).slice(0, 100) : "";
          const resultStr = t.result ? t.result.slice(0, 200) : "";
          return `**${t.name}**${inputStr ? `: ${inputStr}${inputStr.length >= 100 ? "..." : ""}` : ""}\n→ ${resultStr}${(t.result?.length || 0) > 200 ? "..." : ""}`;
        })
        .join("\n\n");

      if (finalContent) {
        finalContent += "\n\n---\n**Tools used:**\n" + toolSummary;
      } else {
        finalContent = "**Tools used:**\n" + toolSummary;
      }
    }

    // Add the completed message to the list
    if (finalContent) {
      setMessages((prev) => [
        ...prev,
        {
          id: messageId || `temp-${Date.now()}`,
          conversationId: conversation.id,
          role: "assistant" as const,
          content: finalContent,
          createdAt: new Date().toISOString(),
        },
      ]);
    }
    setStreamingContent("");
    setActiveTools([]);
    setIsLoading(false);
  }, [conversation.id]);

  const handleError = useCallback((error: string) => {
    console.error("WebSocket error:", error);
    setSystemMessage(`Error: ${error}`);
    setIsLoading(false);
  }, []);

  const { sendMessage, isConnected } = useWebSocket({
    conversationId: conversation.id,
    onChunk: handleChunk,
    onToolUse: handleToolUse,
    onToolResult: handleToolResult,
    onSystem: handleSystem,
    onComplete: handleComplete,
    onError: handleError,
  });

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent, activeTools]);

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
    setActiveTools([]);
    setSystemMessage(null);

    // Send via WebSocket
    sendMessage(
      content,
      conversation.agent,
      !conversation.claudeSessionStarted && messages.length === 0
    );
  };

  const agent = agents.find((a) => a.id === conversation.agent);

  return (
    <>
      {/* Header */}
      <div className="border-b border-gray-700 px-6 py-4">
        <h1 className="text-lg font-medium truncate">{conversation.title}</h1>
        {agent && <p className="text-sm text-gray-400">{agent.name}</p>}
      </div>

      {/* Messages */}
      <ChatArea
        messages={messages}
        streamingContent={streamingContent}
        activeTools={activeTools}
        systemMessage={systemMessage}
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
