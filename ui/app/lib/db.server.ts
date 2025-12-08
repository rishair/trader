import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";

const DB_PATH = path.join(process.cwd(), "db", "trader-ui.db");
const SCHEMA_PATH = path.join(process.cwd(), "db", "schema.sql");

// Ensure db directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// Initialize schema
const schema = fs.readFileSync(SCHEMA_PATH, "utf-8");
db.exec(schema);

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

// Conversation operations
export function getAllConversations(): Conversation[] {
  const rows = db
    .prepare(
      `SELECT id, title, agent, created_at, updated_at, message_count, claude_session_started
       FROM conversations ORDER BY updated_at DESC`
    )
    .all() as any[];

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    agent: row.agent,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count,
    claudeSessionStarted: Boolean(row.claude_session_started),
  }));
}

export function getConversation(id: string): Conversation | null {
  const row = db
    .prepare(
      `SELECT id, title, agent, created_at, updated_at, message_count, claude_session_started
       FROM conversations WHERE id = ?`
    )
    .get(id) as any;

  if (!row) return null;

  return {
    id: row.id,
    title: row.title,
    agent: row.agent,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count,
    claudeSessionStarted: Boolean(row.claude_session_started),
  };
}

export function createConversation(agent: string, title?: string): Conversation {
  const id = uuidv4();
  const now = new Date().toISOString();
  const conversationTitle = title || "New conversation";

  db.prepare(
    `INSERT INTO conversations (id, title, agent, created_at, updated_at, message_count, claude_session_started)
     VALUES (?, ?, ?, ?, ?, 0, 0)`
  ).run(id, conversationTitle, agent, now, now);

  return {
    id,
    title: conversationTitle,
    agent,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    claudeSessionStarted: false,
  };
}

export function updateConversationTitle(id: string, title: string): void {
  db.prepare(`UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?`).run(
    title,
    new Date().toISOString(),
    id
  );
}

export function markConversationStarted(id: string): void {
  db.prepare(
    `UPDATE conversations SET claude_session_started = 1, updated_at = ? WHERE id = ?`
  ).run(new Date().toISOString(), id);
}

export function deleteConversation(id: string): void {
  db.prepare(`DELETE FROM conversations WHERE id = ?`).run(id);
}

// Message operations
export function getMessages(conversationId: string): Message[] {
  const rows = db
    .prepare(
      `SELECT id, conversation_id, role, content, created_at
       FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`
    )
    .all(conversationId) as any[];

  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
  }));
}

export function addMessage(
  conversationId: string,
  role: "user" | "assistant",
  content: string
): Message {
  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, conversationId, role, content, now);

  // Update conversation
  db.prepare(
    `UPDATE conversations
     SET message_count = message_count + 1, updated_at = ?
     WHERE id = ?`
  ).run(now, conversationId);

  return {
    id,
    conversationId,
    role,
    content,
    createdAt: now,
  };
}

export { db };
