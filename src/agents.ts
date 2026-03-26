import { spawn, type ChildProcess } from "node:child_process";
import type { AgentName, AgentSession, ToolUseEvent } from "./types.js";

type DeltaCallback = (text: string) => void;
type ToolUseCallback = (event: ToolUseEvent) => void;
type ActivityCallback = () => void;

const SILENCE_KILL_MS = 5 * 60 * 1000;
const TOOL_SILENCE_KILL_MS = 30 * 60 * 1000;

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

function createWatchdog(
  agent: AgentName,
  child: ChildProcess,
): {
  markActivity: () => void;
  setInFlightTools: (count: number) => void;
  getTimeoutError: () => Error | null;
  clear: () => void;
} {
  let lastActivityAt = Date.now();
  let inFlightTools = 0;
  let timeoutError: Error | null = null;

  const interval = setInterval(() => {
    const silenceMs = Date.now() - lastActivityAt;
    const killAfter = inFlightTools > 0 ? TOOL_SILENCE_KILL_MS : SILENCE_KILL_MS;
    if (silenceMs < killAfter || timeoutError) return;

    const minutes = Math.floor(killAfter / 60000);
    timeoutError = inFlightTools > 0
      ? new Error(
        `${agent} timed out after ${minutes} minutes of silence while tools were running`,
      )
      : new Error(`${agent} timed out after ${minutes} minutes of silence`);
    child.kill();
  }, 1000);

  return {
    markActivity: () => {
      lastActivityAt = Date.now();
    },
    setInFlightTools: (count: number) => {
      inFlightTools = Math.max(0, count);
      lastActivityAt = Date.now();
    },
    getTimeoutError: () => timeoutError,
    clear: () => {
      clearInterval(interval);
    },
  };
}

export function sendToClaude(
  prompt: string,
  session: AgentSession,
  onDelta: DeltaCallback,
  onToolUse: ToolUseCallback,
  onActivity?: ActivityCallback,
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
    const watchdog = createWatchdog("claude", child);

    let fullText = "";
    let sessionId = session.sessionId ?? "";
    const activeTools = new Map<string, string>();
    const lineParser = parseLines((obj: any) => {
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
            if (activeTools.size > 0) {
              for (const [toolKey, toolName] of activeTools) {
                onToolUse({
                  agent: "claude",
                  tool: toolName,
                  summary: "completed",
                  phase: "end",
                });
                activeTools.delete(toolKey);
              }
              watchdog.setInFlightTools(activeTools.size);
            }
            onDelta(newText);
          }
        }

        // Tool use — show indicator and track in-flight tools
        if (block.type === "tool_use" && block.name) {
          const toolKey = block.id
            ? String(block.id)
            : `${block.name}:${JSON.stringify(block.input ?? "")}`;
          if (!activeTools.has(toolKey)) {
            activeTools.set(toolKey, block.name);
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
              phase: "start",
            });
            watchdog.setInFlightTools(activeTools.size);
          }
        }
      }
    });

    child.stdout.on("data", (chunk) => {
      watchdog.markActivity();
      onActivity?.();
      lineParser(chunk);
    });

    child.stderr.on("data", (_chunk) => {
      watchdog.markActivity();
      onActivity?.();
    });

    child.on("close", (code) => {
      activeProcesses.delete(child);
      watchdog.clear();

      if (activeTools.size > 0) {
        for (const [_toolKey, toolName] of activeTools) {
          onToolUse({
            agent: "claude",
            tool: toolName,
            summary: code === 0 ? "completed" : "interrupted",
            phase: "end",
          });
        }
      }

      const timeoutError = watchdog.getTimeoutError();
      if (timeoutError) {
        reject(timeoutError);
        return;
      }

      if (code === 0 || fullText.length > 0) {
        resolve({ sessionId, text: fullText });
      } else {
        reject(new Error(`Claude exited with code ${code}`));
      }
    });

    child.on("error", (err) => {
      activeProcesses.delete(child);
      watchdog.clear();
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
  onActivity?: ActivityCallback,
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
    const watchdog = createWatchdog("codex", child);

    let fullText = "";
    let sessionId = session.sessionId ?? "";
    const activeCommands = new Map<string, string>();
    let commandCounter = 0;

    const lineParser = parseLines((obj: any) => {
      // Extract thread_id
      if (obj.type === "thread.started" && obj.thread_id) {
        sessionId = obj.thread_id;
      }

      if (
        obj.type === "item.started" &&
        obj.item?.type === "command_execution"
      ) {
        const command = String(obj.item.command ?? "?");
        const key = obj.item.id ? String(obj.item.id) : `cmd-${++commandCounter}`;
        activeCommands.set(key, command);
        onToolUse({
          agent: "codex",
          tool: "command",
          summary: command,
          phase: "start",
        });
        watchdog.setInFlightTools(activeCommands.size);
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
        let key = obj.item.id ? String(obj.item.id) : "";
        if (!key || !activeCommands.has(key)) {
          const firstKey = activeCommands.keys().next().value;
          if (firstKey) key = firstKey;
        }
        if (key) activeCommands.delete(key);
        onToolUse({
          agent: "codex",
          tool: "command",
          summary: `${obj.item.command ?? "?"} -> exit ${obj.item.exit_code ?? "?"}`,
          phase: "end",
        });
        watchdog.setInFlightTools(activeCommands.size);
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
          phase: "end",
        });
      }
    });

    child.stdout.on("data", (chunk) => {
      watchdog.markActivity();
      onActivity?.();
      lineParser(chunk);
    });

    child.stderr.on("data", (_chunk) => {
      watchdog.markActivity();
      onActivity?.();
    });

    child.on("close", (code) => {
      activeProcesses.delete(child);
      watchdog.clear();

      if (activeCommands.size > 0) {
        for (const [_toolKey, command] of activeCommands) {
          onToolUse({
            agent: "codex",
            tool: "command",
            summary: `${command} -> interrupted`,
            phase: "end",
          });
        }
      }

      const timeoutError = watchdog.getTimeoutError();
      if (timeoutError) {
        reject(timeoutError);
        return;
      }

      if (code === 0 || fullText.length > 0) {
        resolve({ sessionId, text: fullText });
      } else {
        reject(new Error(`Codex exited with code ${code}`));
      }
    });

    child.on("error", (err) => {
      activeProcesses.delete(child);
      watchdog.clear();
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
  onActivity?: ActivityCallback,
): Promise<{ sessionId: string; text: string }> {
  return agent === "claude"
    ? sendToClaude(prompt, session, onDelta, onToolUse, onActivity)
    : sendToCodex(prompt, session, onDelta, onToolUse, onActivity);
}
