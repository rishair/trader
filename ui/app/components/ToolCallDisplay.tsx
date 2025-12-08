import type { ToolCall } from "~/hooks/useWebSocket";

interface ToolCallDisplayProps {
  tools: ToolCall[];
}

export function ToolCallDisplay({ tools }: ToolCallDisplayProps) {
  if (tools.length === 0) return null;

  return (
    <div className="flex justify-start">
      <div className="max-w-2xl w-full space-y-2">
        {tools.map((tool) => (
          <div
            key={tool.id}
            className={`rounded-lg border ${
              tool.status === "running"
                ? "border-yellow-600 bg-yellow-900/20"
                : "border-green-600 bg-green-900/20"
            }`}
          >
            {/* Tool header */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-700">
              <span className="text-lg">
                {tool.status === "running" ? "⚙️" : "✅"}
              </span>
              <span className="font-medium text-sm">{tool.name}</span>
              {tool.status === "running" && (
                <span className="text-xs text-yellow-400 animate-pulse">running...</span>
              )}
            </div>

            {/* Tool input */}
            {tool.input && Object.keys(tool.input).length > 0 && (
              <div className="px-3 py-2 border-b border-gray-700">
                <div className="text-xs text-gray-400 mb-1">Input:</div>
                <pre className="text-xs bg-gray-800 p-2 rounded overflow-x-auto max-h-32 overflow-y-auto">
                  {formatToolInput(tool.input)}
                </pre>
              </div>
            )}

            {/* Tool result */}
            {tool.result && (
              <div className="px-3 py-2">
                <div className="text-xs text-gray-400 mb-1">Result:</div>
                <pre className="text-xs bg-gray-800 p-2 rounded overflow-x-auto max-h-32 overflow-y-auto whitespace-pre-wrap">
                  {tool.result}
                </pre>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function formatToolInput(input: Record<string, unknown>): string {
  // Special handling for common tool inputs
  if (input.file_path && input.content) {
    // Write/Edit tool - show file path and truncated content
    const content = String(input.content);
    const truncated = content.length > 200 ? content.slice(0, 200) + "..." : content;
    return `file: ${input.file_path}\n---\n${truncated}`;
  }

  if (input.command) {
    // Bash tool
    return `$ ${input.command}`;
  }

  if (input.pattern) {
    // Glob/Grep tool
    return `pattern: ${input.pattern}${input.path ? `\npath: ${input.path}` : ""}`;
  }

  if (input.file_path) {
    // Read tool
    return `file: ${input.file_path}`;
  }

  // Default: pretty print JSON
  return JSON.stringify(input, null, 2);
}
