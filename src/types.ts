export type AgentName = "claude" | "codex";
export type TargetMode = "both" | "claude" | "codex";

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

export interface PendingTurn {
  message: string;
  targets: AgentName[];
}

export interface StateSnapshotV1 {
  schemaVersion: 1;
  savedAt: string;
  transcript: Message[];
  sessions: Record<AgentName, AgentSession>;
  targetMode: TargetMode;
  pendingTurn: PendingTurn | null;
}
