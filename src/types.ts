export type AgentName = "claude" | "codex";

export interface Message {
  role: "user" | "claude" | "codex";
  text: string;
}

export interface AgentSession {
  name: AgentName;
  sessionId: string | null;
  lastMessageIndex: number; // index into transcript of last awareness
}

export interface ToolUseEvent {
  agent: AgentName;
  tool: string;
  summary: string;
  phase: "start" | "end";
}
