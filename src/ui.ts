import * as readline from "node:readline";
import chalk from "chalk";
import type { AgentName, AgentSession, Message, ToolUseEvent } from "./types.js";
import { buildPrompt, parseInput } from "./transcript.js";
import { sendToAgent, interruptAll } from "./agents.js";

const COLORS: Record<AgentName, (s: string) => string> = {
  claude: chalk.magenta,
  codex: chalk.green,
};

const BOLD_COLORS: Record<AgentName, (s: string) => string> = {
  claude: chalk.magenta.bold,
  codex: chalk.green.bold,
};

// Tracks which agent last wrote to stdout, so we can insert headers on switch
let lastWriter: AgentName | null = null;
let midLine = false;

function ensureNewline() {
  if (midLine) {
    process.stdout.write("\n");
    midLine = false;
  }
}

function switchTo(agent: AgentName) {
  if (agent !== lastWriter) {
    ensureNewline();
    process.stdout.write("\n" + BOLD_COLORS[agent](`${agent}> `));
    lastWriter = agent;
    midLine = true;
  }
}

function streamDelta(agent: AgentName, text: string) {
  switchTo(agent);
  process.stdout.write(COLORS[agent](text));
  midLine = !text.endsWith("\n");
}

function showToolUse(event: ToolUseEvent) {
  switchTo(event.agent);
  ensureNewline();
  process.stdout.write(chalk.dim(`  [${event.tool}: ${event.summary}]\n`));
  midLine = false;
}

function printError(agent: AgentName, err: unknown) {
  switchTo(agent);
  ensureNewline();
  const msg = err instanceof Error ? err.message : String(err);
  process.stdout.write(chalk.red(`  [${agent} error: ${msg}]\n`));
  midLine = false;
}

export async function runChatLoop(
  transcript: Message[],
  sessions: Record<AgentName, AgentSession>,
): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.bold.white("you> "),
  });

  rl.prompt();

  let processing = false;

  // Catch Ctrl+C (SIGINT) — interrupt agents if processing, exit if idle
  process.on("SIGINT", () => {
    if (processing) {
      interruptAll();
      ensureNewline();
      process.stdout.write(chalk.yellow("\n  [interrupted]\n\n"));
      midLine = false;
    } else {
      rl.close();
    }
  });

  return new Promise<void>((resolve) => {
    let pasteBuffer: string[] = [];
    let pasteTimer: ReturnType<typeof setTimeout> | null = null;

    async function processInput(fullInput: string) {
      const trimmed = fullInput.trim();
      if (!trimmed) {
        rl.prompt();
        return;
      }

      if (trimmed === "/quit" || trimmed === "/exit") {
        rl.close();
        return;
      }

      processing = true;
      lastWriter = null;

      const parsed = parseInput(trimmed);
      const { targets, message } = parsed;

      // /respond N — agents take turns responding to each other
      if (parsed.respond) {
        const rounds = parsed.respond;
        const first = parsed.respondStart ?? "claude";
        const second: AgentName = first === "claude" ? "codex" : "claude";
        const order: AgentName[] = [first, second];
        process.stdout.write(chalk.dim(`  [agents responding for ${rounds} rounds...]\n`));

        for (let i = 0; i < rounds; i++) {
          const agent = order[i % 2];
          const prompt = buildPrompt(transcript, sessions[agent]);

          if (!prompt.trim()) {
            process.stdout.write(chalk.dim(`  [nothing new for ${agent} to respond to]\n`));
            break;
          }

          switchTo(agent);

          try {
            const response = await sendToAgent(
              agent,
              prompt,
              sessions[agent],
              (delta) => streamDelta(agent, delta),
              (event) => showToolUse(event),
            );
            ensureNewline();
            sessions[agent].sessionId = response.sessionId;
            transcript.push({ role: agent, text: response.text });
            sessions[agent].lastMessageIndex = transcript.length - 1;
          } catch (err) {
            printError(agent, err);
            break;
          }
        }

        process.stdout.write("\n");
        processing = false;
        rl.prompt();
        return;
      }

      transcript.push({ role: "user", text: message });

      if (targets.length === 1) {
        // Single agent — straightforward
        const target = targets[0];
        const prompt = buildPrompt(transcript, sessions[target]);

        try {
          const response = await sendToAgent(
            target,
            prompt,
            sessions[target],
            (delta) => streamDelta(target, delta),
            (event) => showToolUse(event),
          );
          ensureNewline();
          sessions[target].sessionId = response.sessionId;
          transcript.push({ role: target, text: response.text });
          sessions[target].lastMessageIndex = transcript.length - 1;
        } catch (err) {
          printError(target, err);
        }
      } else {
        // Both agents — build prompts BEFORE starting either, then run in parallel
        const userMsgIdx = transcript.length - 1;
        const prompts = new Map<AgentName, string>();
        for (const target of targets) {
          prompts.set(target, buildPrompt(transcript, sessions[target]));
        }

        const results = await Promise.allSettled(
          targets.map((target) =>
            sendToAgent(
              target,
              prompts.get(target)!,
              sessions[target],
              (delta) => streamDelta(target, delta),
              (event) => showToolUse(event),
            ).then((response) => ({ target, response })),
          ),
        );

        ensureNewline();

        // Add responses to transcript. Set lastMessageIndex to the user message
        // (the last thing they actually saw), so on the next turn each agent
        // gets the other's parallel response as missed context.
        for (const result of results) {
          if (result.status === "fulfilled") {
            const { target, response } = result.value;
            sessions[target].sessionId = response.sessionId;
            transcript.push({ role: target, text: response.text });
            sessions[target].lastMessageIndex = userMsgIdx;
          } else {
            const succeeded = results
              .filter((r) => r.status === "fulfilled")
              .map((r) => (r as PromiseFulfilledResult<{ target: AgentName }>).value.target);
            const failed = targets.find((t) => !succeeded.includes(t));
            if (failed) printError(failed, result.reason);
          }
        }
      }

      process.stdout.write("\n");
      processing = false;
      rl.prompt();
    }

    // Buffer rapid lines (multiline paste) into a single message.
    // After 50ms of no new lines, flush the buffer as one input.
    rl.on("line", (line) => {
      if (processing) return;
      pasteBuffer.push(line);
      if (pasteTimer) clearTimeout(pasteTimer);
      pasteTimer = setTimeout(() => {
        const full = pasteBuffer.join("\n");
        pasteBuffer = [];
        pasteTimer = null;
        processInput(full);
      }, 50);
    });

    rl.on("close", () => {
      console.log(chalk.cyan("\nGoodbye!"));
      resolve();
    });
  });
}
