#!/usr/bin/env node

import { execSync, spawnSync } from "node:child_process";
import path from "node:path";
import chalk from "chalk";
import type {
  AgentName,
  AgentSession,
  Message,
  PendingTurn,
  StateSnapshotV1,
  TargetMode,
} from "./types.js";
import { runChatLoop } from "./ui.js";
import { sendToAgent } from "./agents.js";
import {
  getDefaultStatePath,
  loadStateSnapshot,
  saveStateSnapshot,
} from "./state.js";

interface CliArgs {
  claudeSession: string | null;
  codexSession: string | null;
  restorePath: string | null;
}

// Vibrant colors for UI chrome
const CLAUDE_COLOR = "#FF8C00";
const CODEX_COLOR = "#1E90FF";
// Lighter versions for agent output
const CLAUDE_COLOR_LIGHT = "#FFC680";
const CODEX_COLOR_LIGHT = "#8FC8FF";

function checkCli(name: string): boolean {
  try {
    execSync(`which ${name}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  let claudeSession: string | null = null;
  let codexSession: string | null = null;
  let restorePath: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--claude-session" && args[i + 1]) claudeSession = args[++i];
    if (args[i] === "--codex-session" && args[i + 1]) codexSession = args[++i];
    if (args[i] === "--restore" && args[i + 1]) restorePath = args[++i];
  }

  return { claudeSession, codexSession, restorePath };
}

function printBanner() {
  console.log(chalk.cyan.bold("\n=== Chatroom ==="));
  console.log(chalk.cyan("Claude Code + Codex CLI in conversation\n"));
  console.log(chalk.dim("  @claude <msg>   → Claude responds"));
  console.log(chalk.dim("  @codex <msg>    → Codex responds"));
  console.log(chalk.dim("  <msg>           → both respond"));
  console.log(chalk.dim("  Shift+Tab       → cycle default target (both/claude/codex)"));
  console.log(chalk.dim("  Ctrl+C          → interrupt agents, or quit when idle"));
  console.log(chalk.dim("  /respond N      → agents take N turns responding to each other"));
  console.log(chalk.dim("  /clear or /new  → start fresh session for focused target"));
  console.log(chalk.dim("  /rebuild        → rebuild and relaunch while preserving chat state"));
  console.log(chalk.dim("  /retry          → retry the interrupted user turn (if available)"));
  console.log(chalk.dim("  /quit           → force-exit\n"));
}

async function preseedAgents(
  transcript: Message[],
  sessions: Record<AgentName, AgentSession>,
): Promise<void> {
  console.log(chalk.dim("  Connecting agents..."));

  const preseed =
    "You are joining a collaborative chatroom with a human user and another AI assistant. " +
    "Messages will be prefixed with [user], [claude], or [codex] to show who said what.\n\n" +
    "IMPORTANT RULES:\n" +
    "- This is a PLANNING and DISCUSSION space. Do NOT make code changes, edit files, or run commands unless the user explicitly asks you to.\n" +
    "- Focus on collaborative thinking: brainstorm, debate trade-offs, suggest approaches, ask clarifying questions.\n" +
    "- Keep responses concise and conversational. This is a chat, not a monologue.\n" +
    "- Build on what the other agent says. Agree, disagree, or refine their ideas.\n" +
    "- When you disagree with the other agent, say so directly and explain why.\n" +
    "- Wait for explicit permission before implementing anything.\n\n" +
    "Say a brief one-sentence greeting to introduce yourself to the room.";

  const agents: AgentName[] = ["claude", "codex"];
  const results = await Promise.allSettled(
    agents.map((agent) => {
      const ctx = agent === "claude"
        ? "You are Claude, made by Anthropic. The other AI in this room is Codex, made by OpenAI."
        : "You are Codex, made by OpenAI. The other AI in this room is Claude, made by Anthropic.";
      return sendToAgent(
        agent,
        ctx + "\n\n" + preseed,
        sessions[agent],
        () => {},
        () => {},
      );
    }),
  );

  for (let i = 0; i < agents.length; i++) {
    const result = results[i];
    const agent = agents[i];
    if (result.status === "fulfilled") {
      sessions[agent].sessionId = result.value.sessionId;
      transcript.push({ role: agent, text: result.value.text });
      sessions[agent].lastMessageIndex = transcript.length - 1;
      const color = agent === "claude"
        ? chalk.hex(CLAUDE_COLOR_LIGHT)
        : chalk.hex(CODEX_COLOR_LIGHT);
      console.log(color(`\n  ${agent}: ${result.value.text}`));
    } else {
      console.log(chalk.red(`  ${agent} failed to connect: ${result.reason}`));
    }
  }
  console.log();
}

/** Rebuild the project and relaunch with `--restore`. Runs the new process
 *  synchronously (parent holds the TTY open) then exits with its status code.
 *  On build failure, returns normally so the caller can fall back. */
async function rebuildAndRelaunch(snapshot: StateSnapshotV1): Promise<void> {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

  console.log(chalk.cyan("\n  [rebuild] running `npm run build`...\n"));
  const buildResult = spawnSync(npmCommand, ["run", "build"], {
    stdio: "inherit",
    env: { ...process.env },
  });

  if (buildResult.status !== 0) {
    console.log(chalk.red("\n  [rebuild] build failed; staying in current session\n"));
    return;
  }

  const statePath = getDefaultStatePath();
  await saveStateSnapshot(snapshot, statePath);

  const relaunchEntry = path.join(process.cwd(), "dist", "index.js");
  const relaunchArgs = [relaunchEntry, "--restore", statePath];

  console.log(chalk.cyan("  [rebuild] relaunching...\n"));

  const relaunchResult = spawnSync(process.execPath, relaunchArgs, {
    stdio: "inherit",
    env: { ...process.env },
  });

  if (relaunchResult.error) {
    console.error(chalk.red(`  [rebuild] relaunch failed: ${String(relaunchResult.error)}`));
    process.exit(1);
  }

  process.exit(relaunchResult.status ?? 1);
}

async function main() {
  if (!checkCli("claude")) {
    console.error(chalk.red("Error: claude CLI not found. Install Claude Code first."));
    process.exit(1);
  }
  if (!checkCli("codex")) {
    console.error(chalk.red("Error: codex CLI not found. Install Codex CLI first."));
    process.exit(1);
  }

  const { claudeSession, codexSession, restorePath } = parseArgs();

  printBanner();

  const transcript: Message[] = [];
  const sessions: Record<AgentName, AgentSession> = {
    claude: { name: "claude", sessionId: claudeSession, lastMessageIndex: -1 },
    codex: { name: "codex", sessionId: codexSession, lastMessageIndex: -1 },
  };

  let targetMode: TargetMode = "both";
  let pendingTurn: PendingTurn | null = null;
  let restoredAt: string | null = null;

  if (restorePath) {
    const snapshot = await loadStateSnapshot(restorePath);
    transcript.push(...snapshot.transcript);
    sessions.claude = { ...snapshot.sessions.claude };
    sessions.codex = { ...snapshot.sessions.codex };
    targetMode = snapshot.targetMode;
    pendingTurn = snapshot.pendingTurn;
    restoredAt = snapshot.savedAt;

    if (claudeSession || codexSession) {
      console.log(chalk.dim("  [restore] ignoring --claude-session/--codex-session because --restore was provided\n"));
    }
  } else if (claudeSession || codexSession) {
    console.log(chalk.cyan("Resuming sessions:"));
    if (claudeSession) console.log(chalk.hex(CLAUDE_COLOR)(`  claude: ${claudeSession}`));
    if (codexSession) console.log(chalk.hex(CODEX_COLOR)(`  codex:  ${codexSession}`));
    console.log();
  }

  if (!restorePath && !claudeSession && !codexSession) {
    await preseedAgents(transcript, sessions);
  }

  let showRestoreBanner = Boolean(restorePath);
  while (true) {
    const loopResult = await runChatLoop(transcript, sessions, {
      initialTargetMode: targetMode,
      initialPendingTurn: pendingTurn,
      restoredAt: showRestoreBanner ? restoredAt : null,
    });

    showRestoreBanner = false;
    restoredAt = null;

    if (loopResult.kind === "exit") break;

    targetMode = loopResult.snapshot.targetMode;
    pendingTurn = loopResult.snapshot.pendingTurn;

    // rebuildAndRelaunch exits the process on success; if it returns, build failed.
    await rebuildAndRelaunch(loopResult.snapshot);

    // Rebuild failed; reopen chat loop without dropping state.
    console.log(chalk.yellow("  [rebuild] continuing existing session\n"));
  }

  const cs = sessions.claude.sessionId;
  const xs = sessions.codex.sessionId;
  if (cs || xs) {
    const parts = ["chatroom"];
    if (cs) parts.push("--claude-session", cs);
    if (xs) parts.push("--codex-session", xs);
    console.log(chalk.dim("\nTo resume this conversation:"));
    console.log(chalk.white.bold(`  ${parts.join(" ")}\n`));
  }
}

main().catch((error) => {
  console.error(chalk.red(`Fatal error: ${String(error)}`));
  process.exit(1);
});
