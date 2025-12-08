import { json } from "@remix-run/node";
import { Outlet, useLoaderData, Link, useParams } from "@remix-run/react";
import { getAllConversations } from "~/lib/db.server";
import { getAvailableAgents } from "~/lib/agents.server";
import { Sidebar } from "~/components/Sidebar";

export const loader = async () => {
  const conversations = getAllConversations();
  const agents = getAvailableAgents();
  return json({ conversations, agents });
};

export default function ChatLayout() {
  const { conversations, agents } = useLoaderData<typeof loader>();
  const params = useParams();

  return (
    <div className="flex h-screen">
      <Sidebar
        conversations={conversations}
        currentId={params.id}
        agents={agents}
      />
      <main className="flex-1 flex flex-col">
        <Outlet context={{ agents }} />
      </main>
    </div>
  );
}
