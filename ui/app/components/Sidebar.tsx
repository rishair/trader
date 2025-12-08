import { Link } from "@remix-run/react";
import type { Conversation, Agent } from "~/types";

interface SidebarProps {
  conversations: Conversation[];
  currentId?: string;
  agents: Agent[];
}

function groupConversationsByDate(conversations: Conversation[]) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const lastWeek = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

  const groups: { label: string; items: Conversation[] }[] = [
    { label: "Today", items: [] },
    { label: "Yesterday", items: [] },
    { label: "Last 7 Days", items: [] },
    { label: "Older", items: [] },
  ];

  conversations.forEach((conv) => {
    const date = new Date(conv.updatedAt);
    if (date >= today) {
      groups[0].items.push(conv);
    } else if (date >= yesterday) {
      groups[1].items.push(conv);
    } else if (date >= lastWeek) {
      groups[2].items.push(conv);
    } else {
      groups[3].items.push(conv);
    }
  });

  return groups.filter((g) => g.items.length > 0);
}

export function Sidebar({ conversations, currentId, agents }: SidebarProps) {
  const groups = groupConversationsByDate(conversations);
  const getAgentName = (agentId: string) =>
    agents.find((a) => a.id === agentId)?.name || agentId;

  return (
    <aside className="w-64 bg-gray-800 border-r border-gray-700 flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-gray-700">
        <Link
          to="/chat/new"
          className="block w-full py-2 px-4 bg-blue-600 hover:bg-blue-700 rounded-lg font-medium text-center transition-colors"
        >
          + New Chat
        </Link>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto p-2">
        {groups.map((group) => (
          <div key={group.label} className="mb-4">
            <h3 className="text-xs text-gray-500 uppercase px-2 mb-1 font-medium">
              {group.label}
            </h3>
            {group.items.map((conv) => (
              <Link
                key={conv.id}
                to={`/chat/${conv.id}`}
                className={`block w-full text-left p-2 rounded-lg mb-1 transition-colors ${
                  currentId === conv.id
                    ? "bg-gray-700"
                    : "hover:bg-gray-700/50"
                }`}
              >
                <div className="truncate text-sm">{conv.title}</div>
                <div className="text-xs text-gray-500 truncate">
                  {getAgentName(conv.agent)}
                </div>
              </Link>
            ))}
          </div>
        ))}

        {conversations.length === 0 && (
          <div className="text-center text-gray-500 py-8">
            <p className="text-sm">No conversations yet</p>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-gray-700 text-xs text-gray-500">
        Trader Bot UI
      </div>
    </aside>
  );
}
