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
