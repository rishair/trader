import { json, redirect } from "@remix-run/node";
import type { ActionFunctionArgs } from "@remix-run/node";
import { Form, useOutletContext, useNavigation } from "@remix-run/react";
import { createConversation } from "~/lib/db.server";
import type { Agent } from "~/types";
import { useState } from "react";

export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const agent = formData.get("agent") as string;

  if (!agent) {
    return json({ error: "Agent is required" }, { status: 400 });
  }

  const conversation = createConversation(agent);
  return redirect(`/chat/${conversation.id}`);
};

export default function NewChat() {
  const { agents } = useOutletContext<{ agents: Agent[] }>();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";
  const [selectedAgent, setSelectedAgent] = useState(agents[0]?.id || "trade-research");

  const selectedAgentInfo = agents.find((a) => a.id === selectedAgent);

  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="w-full max-w-md p-6">
        <h2 className="text-2xl font-semibold mb-6 text-center">Start New Chat</h2>

        <Form method="post" className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Select Agent
            </label>
            <select
              name="agent"
              value={selectedAgent}
              onChange={(e) => setSelectedAgent(e.target.value)}
              className="w-full px-4 py-3 bg-gray-800 border border-gray-700 rounded-lg focus:outline-none focus:border-blue-500"
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
            {selectedAgentInfo && (
              <p className="mt-2 text-sm text-gray-400">
                {selectedAgentInfo.description}
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
          >
            {isSubmitting ? "Creating..." : "Start Conversation"}
          </button>
        </Form>
      </div>
    </div>
  );
}
