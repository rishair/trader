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
