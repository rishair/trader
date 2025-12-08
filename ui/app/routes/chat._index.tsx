import { useOutletContext } from "@remix-run/react";
import type { Agent } from "~/types";

export default function ChatIndex() {
  const { agents } = useOutletContext<{ agents: Agent[] }>();

  return (
    <div className="flex-1 flex items-center justify-center text-gray-500">
      <div className="text-center">
        <h2 className="text-xl font-medium mb-2">Welcome to Trader Bot</h2>
        <p className="mb-4">Select a conversation or start a new one</p>
        <a
          href="/chat/new"
          className="inline-block px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg"
        >
          + New Chat
        </a>
      </div>
    </div>
  );
}
