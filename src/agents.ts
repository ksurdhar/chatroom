import { spawn, type ChildProcess } from "node:child_process";
import type { AgentName, AgentSession, ToolUseEvent } from "./types.js";

type DeltaCallback = (text: string) => void;
type ToolUseCallback = (event: ToolUseEvent) => void;

// Track active child processes so they can be interrupted
export const activeProcesses: Set<ChildProcess> = new Set();

export function interruptAll(): void {
  for (const child of activeProcesses) {
    child.kill("SIGINT");
  }
}

function parseLines(
  onLine: (obj: unknown) => void,
): (chunk: Buffer) => void {
  let buffer = "";
  return (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onLine(JSON.parse(line));
      } catch {
        // skip non-JSON lines
      }
    }
  };
}

export function sendToClaude(
  prompt: string,
  session: AgentSession,
  onDelta: DeltaCallback,
  onToolUse: ToolUseCallback,
): Promise<{ sessionId: string; text: string }> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
    ];

    if (session.sessionId) {
      args.push("--resume", session.sessionId);
    }

    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    activeProcesses.add(child);

    let fullText = "";
    let sessionId = session.sessionId ?? "";
    let currentToolName = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Claude timed out after 5 minutes"));
    }, 5 * 60 * 1000);

    child.stdout.on("data", parseLines((obj: any) => {
      // Extract session_id from init event
      if (obj.type === "system" && obj.session_id) {
        sessionId = obj.session_id;
      }

      if (obj.type !== "assistant") return;

      const msg = obj.message;
      if (!msg || !Array.isArray(msg.content)) return;

      for (const block of msg.content) {
        // Text content — emit the full text each time (it accumulates)
        if (block.type === "text" && block.text) {
          const newText = block.text.slice(fullText.length);
          if (newText) {
            fullText = block.text;
            onDelta(newText);
          }
        }

        // Tool use — show indicator
        if (block.type === "tool_use" && block.name) {
          if (block.name !== currentToolName) {
            currentToolName = block.name;
            const inputStr = block.input
              ? typeof block.input === "string"
                ? block.input
                : JSON.stringify(block.input)
              : "";
            const summary = inputStr.length > 80
              ? inputStr.slice(0, 80) + "..."
              : inputStr;
            onToolUse({
              agent: "claude",
              tool: block.name,
              summary,
            });
          }
        }
      }
    }));

    child.stderr.on("data", () => {
      // ignore stderr
    });

    child.on("close", (code) => {
      activeProcesses.delete(child);
      clearTimeout(timeout);
      if (code === 0 || fullText.length > 0) {
        resolve({ sessionId, text: fullText });
      } else {
        reject(new Error(`Claude exited with code ${code}`));
      }
    });

    child.on("error", (err) => {
      activeProcesses.delete(child);
      clearTimeout(timeout);
      reject(err);
    });

    // Write prompt to stdin and close
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

export function sendToCodex(
  prompt: string,
  session: AgentSession,
  onDelta: DeltaCallback,
  onToolUse: ToolUseCallback,
): Promise<{ sessionId: string; text: string }> {
  return new Promise((resolve, reject) => {
    const args: string[] = ["exec"];

    if (session.sessionId) {
      args.push("resume", session.sessionId);
    }

    args.push("-", "--json", "--full-auto", "--skip-git-repo-check");

    const child = spawn("codex", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    activeProcesses.add(child);

    let fullText = "";
    let sessionId = session.sessionId ?? "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Codex timed out after 5 minutes"));
    }, 5 * 60 * 1000);

    child.stdout.on("data", parseLines((obj: any) => {
      // Extract thread_id
      if (obj.type === "thread.started" && obj.thread_id) {
        sessionId = obj.thread_id;
      }

      // Agent message text
      if (
        obj.type === "item.completed" &&
        obj.item?.type === "agent_message" &&
        obj.item.text
      ) {
        const text = obj.item.text;
        fullText += (fullText ? "\n" : "") + text;
        onDelta(text);
      }

      // Command execution
      if (
        obj.type === "item.completed" &&
        obj.item?.type === "command_execution"
      ) {
        onToolUse({
          agent: "codex",
          tool: "command",
          summary: `${obj.item.command ?? "?"} → exit ${obj.item.exit_code ?? "?"}`,
        });
      }

      // File changes
      if (
        obj.type === "item.completed" &&
        obj.item?.type === "file_change"
      ) {
        onToolUse({
          agent: "codex",
          tool: "file_change",
          summary: obj.item.file ?? "unknown file",
        });
      }
    }));

    child.stderr.on("data", () => {
      // ignore stderr
    });

    child.on("close", (code) => {
      activeProcesses.delete(child);
      clearTimeout(timeout);
      if (code === 0 || fullText.length > 0) {
        resolve({ sessionId, text: fullText });
      } else {
        reject(new Error(`Codex exited with code ${code}`));
      }
    });

    child.on("error", (err) => {
      activeProcesses.delete(child);
      clearTimeout(timeout);
      reject(err);
    });

    // Write prompt to stdin and close
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

export function sendToAgent(
  agent: AgentName,
  prompt: string,
  session: AgentSession,
  onDelta: DeltaCallback,
  onToolUse: ToolUseCallback,
): Promise<{ sessionId: string; text: string }> {
  return agent === "claude"
    ? sendToClaude(prompt, session, onDelta, onToolUse)
    : sendToCodex(prompt, session, onDelta, onToolUse);
}
