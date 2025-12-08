import { Message } from "./Message";
import { ToolCallDisplay } from "./ToolCallDisplay";
import type { Message as MessageType } from "~/types";
import type { ToolCall } from "~/hooks/useWebSocket";

interface ChatAreaProps {
  messages: MessageType[];
  streamingContent: string;
  activeTools: ToolCall[];
  systemMessage: string | null;
  isLoading: boolean;
}

export function ChatArea({
  messages,
  streamingContent,
  activeTools,
  systemMessage,
  isLoading,
}: ChatAreaProps) {
  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-4">
      {messages.length === 0 && !streamingContent && !isLoading && (
        <div className="h-full flex items-center justify-center text-gray-500">
          <p>Send a message to start the conversation</p>
        </div>
      )}

      {messages.map((message) => (
        <Message key={message.id} message={message} />
      ))}

      {/* System message (session info) */}
      {systemMessage && (
        <div className="flex justify-center">
          <div className="text-xs text-gray-500 bg-gray-800 px-3 py-1 rounded-full">
            {systemMessage}
          </div>
        </div>
      )}

      {/* Active tool calls */}
      {activeTools.length > 0 && <ToolCallDisplay tools={activeTools} />}

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
      {isLoading && !streamingContent && activeTools.length === 0 && (
        <div className="flex justify-start">
          <div className="bg-gray-700 rounded-lg rounded-bl-sm px-4 py-3">
            <div className="flex space-x-1">
              <div
                className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"
                style={{ animationDelay: "0ms" }}
              />
              <div
                className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"
                style={{ animationDelay: "150ms" }}
              />
              <div
                className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"
                style={{ animationDelay: "300ms" }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
