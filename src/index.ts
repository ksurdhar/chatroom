#!/usr/bin/env node

import { execSync } from "node:child_process";
import chalk from "chalk";
import type { AgentName, AgentSession, Message } from "./types.js";
import { runChatLoop } from "./ui.js";
import { sendToAgent } from "./agents.js";

function checkCli(name: string): boolean {
  try {
    execSync(`which ${name}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function parseArgs(): { claudeSession: string | null; codexSession: string | null } {
  const args = process.argv.slice(2);
  let claudeSession: string | null = null;
  let codexSession: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--claude-session" && args[i + 1]) claudeSession = args[++i];
    if (args[i] === "--codex-session" && args[i + 1]) codexSession = args[++i];
  }
  return { claudeSession, codexSession };
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

  const { claudeSession, codexSession } = parseArgs();

  console.log(chalk.cyan.bold("\n=== Chatroom ==="));
  console.log(chalk.cyan("Claude Code + Codex CLI in conversation\n"));
  console.log(chalk.dim("  @claude <msg>   → Claude responds"));
  console.log(chalk.dim("  @codex <msg>    → Codex responds"));
  console.log(chalk.dim("  <msg>           → both respond"));
  console.log(chalk.dim("  Shift+Tab       → cycle default target (both/claude/codex)"));
  console.log(chalk.dim("  Ctrl+C          → interrupt focused target (does not exit)"));
  console.log(chalk.dim("  Esc Esc         → force-exit and terminate active agents"));
  console.log(chalk.dim("  /respond N      → agents take N turns responding to each other"));
  console.log(chalk.dim("  /clear or /new  → start fresh session for focused target"));
  console.log(chalk.dim("  /quit           → force-exit\n"));

  if (claudeSession || codexSession) {
    console.log(chalk.cyan("Resuming sessions:"));
    if (claudeSession) console.log(chalk.magenta(`  claude: ${claudeSession}`));
    if (codexSession) console.log(chalk.green(`  codex:  ${codexSession}`));
    console.log();
  }

  const transcript: Message[] = [];
  const sessions: Record<AgentName, AgentSession> = {
    claude: { name: "claude", sessionId: claudeSession, lastMessageIndex: -1 },
    codex: { name: "codex", sessionId: codexSession, lastMessageIndex: -1 },
  };

  // Preseed both agents with chatroom context (skip if resuming)
  if (!claudeSession && !codexSession) {
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
          () => {},  // silent — don't stream preseed output
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
        const color = agent === "claude" ? chalk.magenta : chalk.green;
        console.log(color(`\n  ${agent}: ${result.value.text}`));
      } else {
        console.log(chalk.red(`  ${agent} failed to connect: ${result.reason}`));
      }
    }
    console.log();
  }

  await runChatLoop(transcript, sessions);

  // Print resume command if sessions exist
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

main();
