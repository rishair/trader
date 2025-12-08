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
