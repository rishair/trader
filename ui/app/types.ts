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
