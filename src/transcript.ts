import type { Message, AgentSession, AgentName } from "./types.js";

const CHATROOM_CONTEXT: Record<AgentName, string> = {
  claude:
    "You are participating in a group chatroom with a human user and another AI assistant called Codex (OpenAI). Messages from the user are prefixed with [user]. Messages from Codex are prefixed with [codex]. Keep responses concise unless asked for detail. You can reference, agree with, or disagree with what Codex said.",
  codex:
    "You are participating in a group chatroom with a human user and another AI assistant called Claude (Anthropic). Messages from the user are prefixed with [user]. Messages from Claude are prefixed with [claude]. Keep responses concise unless asked for detail. You can reference, agree with, or disagree with what Claude said.",
};

export function buildPrompt(
  transcript: Message[],
  session: AgentSession,
): string {
  const missedStart = session.lastMessageIndex + 1;
  // Filter out the agent's own messages — they already have them via --resume
  const missed = transcript.slice(missedStart).filter(msg => msg.role !== session.name);

  const parts: string[] = [];

  // First turn: include chatroom context
  if (session.sessionId === null) {
    parts.push(CHATROOM_CONTEXT[session.name]);
    parts.push("");
  }

  // Show all missed messages (user messages, other agent's responses)
  // Each prefixed with the sender so the agent knows who said what
  if (missed.length > 0) {
    if (missed.length > 1 || session.sessionId !== null) {
      for (const msg of missed) {
        parts.push(`[${msg.role}]: ${msg.text}`);
      }
    } else {
      // Only one message and first turn — just send it directly
      parts.push(missed[0].text);
    }
  }

  return parts.join("\n");
}

export interface ParsedInput {
  targets: AgentName[];
  message: string;
  respond?: number;
  respondStart?: AgentName;
}

export function parseInput(
  raw: string,
  defaultTarget: AgentName | "both" = "both",
): ParsedInput {
  const trimmed = raw.trim();
  if (trimmed.startsWith("/respond")) {
    const rest = trimmed.slice(9).trim();
    const n = parseInt(rest, 10) || 2;
    // Check for @codex or @claude after the number
    const afterNum = rest.replace(/^\d+\s*/, "");
    let startWith: AgentName = "claude";
    if (afterNum.startsWith("@codex")) startWith = "codex";
    return { targets: [], message: "", respond: n, respondStart: startWith };
  }
  if (trimmed.startsWith("@claude "))
    return { targets: ["claude"], message: trimmed.slice(8) };
  if (trimmed.startsWith("@codex "))
    return { targets: ["codex"], message: trimmed.slice(7) };
  if (trimmed.startsWith("@both "))
    return { targets: ["claude", "codex"], message: trimmed.slice(6) };

  if (defaultTarget === "both") {
    return { targets: ["claude", "codex"], message: trimmed };
  }
  return { targets: [defaultTarget], message: trimmed };
}
