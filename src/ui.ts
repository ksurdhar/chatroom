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

const SPINNER_FRAMES = ["|", "/", "-", "\\"];

interface AgentUiState {
  state: "idle" | "streaming" | "tool_running" | "done" | "error";
  inFlightTools: number;
  activeTool: string | null;
  lastActivityAt: number;
}

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
  const phase = event.phase === "start" ? "start" : "done";
  process.stdout.write(chalk.dim(`  [${phase} ${event.tool}: ${event.summary}]\n`));
  midLine = false;
}

function printError(agent: AgentName, err: unknown) {
  switchTo(agent);
  ensureNewline();
  const msg = err instanceof Error ? err.message : String(err);
  process.stdout.write(chalk.red(`  [${agent} error: ${msg}]\n`));
  midLine = false;
}

function createInitialAgentStates(): Record<AgentName, AgentUiState> {
  const now = Date.now();
  return {
    claude: {
      state: "idle",
      inFlightTools: 0,
      activeTool: null,
      lastActivityAt: now,
    },
    codex: {
      state: "idle",
      inFlightTools: 0,
      activeTool: null,
      lastActivityAt: now,
    },
  };
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

  let processing = false;
  let interrupted = false;
  let spinnerIndex = 0;
  let statusTimer: ReturnType<typeof setInterval> | null = null;
  let agentStates = createInitialAgentStates();

  function resetAgentStates() {
    agentStates = createInitialAgentStates();
  }

  function markActivity(agent: AgentName) {
    agentStates[agent].lastActivityAt = Date.now();
  }

  function setAgentState(agent: AgentName, state: AgentUiState["state"]) {
    agentStates[agent].state = state;
    markActivity(agent);
  }

  function applyToolEvent(event: ToolUseEvent) {
    if (event.agent === "codex" && event.tool === "file_change") {
      return;
    }

    const st = agentStates[event.agent];
    markActivity(event.agent);

    if (event.phase === "start") {
      st.inFlightTools += 1;
      st.activeTool = event.tool;
      st.state = "tool_running";
      return;
    }

    st.inFlightTools = Math.max(0, st.inFlightTools - 1);
    if (st.inFlightTools === 0) {
      st.activeTool = null;
      st.state = "streaming";
    }
  }

  function formatAgentStatus(agent: AgentName): string | null {
    const st = agentStates[agent];
    if (st.state === "idle") return null;

    const silenceSec = Math.floor((Date.now() - st.lastActivityAt) / 1000);
    const baseLabel = st.state === "tool_running"
      ? `${agent}:running ${st.activeTool ?? "tool"}`
      : st.state === "error"
      ? `${agent}:error`
      : st.state === "done"
      ? `${agent}:done`
      : `${agent}:working`;

    if (st.state === "error" || st.state === "done") return baseLabel;

    if (silenceSec >= 60) return `${baseLabel} possibly-stalled (${silenceSec}s)`;
    if (silenceSec >= 15) return `${baseLabel} still-working (${silenceSec}s)`;
    if (silenceSec >= 3) return `${baseLabel} ... (${silenceSec}s)`;

    return baseLabel;
  }

  function promptText(): string {
    if (!processing) return chalk.bold.white("you> ");

    const statuses = (["claude", "codex"] as AgentName[])
      .map((agent) => formatAgentStatus(agent))
      .filter((s): s is string => Boolean(s));

    const spinner = SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length];
    if (statuses.length === 0) {
      return chalk.bold.white(`you [${spinner} working]> `);
    }

    return chalk.bold.white(`you [${spinner} ${statuses.join(" | ")}]> `);
  }

  function refreshPrompt() {
    rl.setPrompt(promptText());
    rl.prompt(true);
  }

  function startStatusLoop() {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = setInterval(() => {
      spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
      if (processing && !midLine) refreshPrompt();
    }, 200);
  }

  function stopStatusLoop() {
    if (!statusTimer) return;
    clearInterval(statusTimer);
    statusTimer = null;
  }

  refreshPrompt();

  // Catch Ctrl+C (SIGINT) — interrupt agents if processing, exit if idle
  process.on("SIGINT", () => {
    if (processing) {
      interrupted = true;
      interruptAll();
      ensureNewline();
      process.stdout.write(chalk.yellow("\n  [interrupted]\n\n"));
      midLine = false;
      processing = false;
      stopStatusLoop();
      resetAgentStates();
      refreshPrompt();
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
        refreshPrompt();
        return;
      }

      if (trimmed === "/quit" || trimmed === "/exit") {
        rl.close();
        return;
      }

      processing = true;
      interrupted = false;
      lastWriter = null;
      resetAgentStates();
      startStatusLoop();
      refreshPrompt();

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
          if (interrupted) break;

          const agent = order[i % 2];
          const prompt = buildPrompt(transcript, sessions[agent]);

          if (!prompt.trim()) {
            process.stdout.write(chalk.dim(`  [nothing new for ${agent} to respond to]\n`));
            break;
          }

          setAgentState(agent, "streaming");
          refreshPrompt();

          try {
            const response = await sendToAgent(
              agent,
              prompt,
              sessions[agent],
              (delta) => {
                setAgentState(agent, "streaming");
                streamDelta(agent, delta);
              },
              (event) => {
                applyToolEvent(event);
                showToolUse(event);
                refreshPrompt();
              },
              () => {
                markActivity(agent);
              },
            );

            if (interrupted) break;

            ensureNewline();
            setAgentState(agent, "done");
            sessions[agent].sessionId = response.sessionId;
            transcript.push({ role: agent, text: response.text });
            sessions[agent].lastMessageIndex = transcript.length - 1;
          } catch (err) {
            setAgentState(agent, "error");
            if (!interrupted) printError(agent, err);
            break;
          }

          refreshPrompt();
        }

        process.stdout.write("\n");
        processing = false;
        stopStatusLoop();
        resetAgentStates();
        refreshPrompt();
        return;
      }

      transcript.push({ role: "user", text: message });

      if (targets.length === 1) {
        // Single agent — straightforward
        const target = targets[0];
        const prompt = buildPrompt(transcript, sessions[target]);
        setAgentState(target, "streaming");
        refreshPrompt();

        try {
          const response = await sendToAgent(
            target,
            prompt,
            sessions[target],
            (delta) => {
              setAgentState(target, "streaming");
              streamDelta(target, delta);
            },
            (event) => {
              applyToolEvent(event);
              showToolUse(event);
              refreshPrompt();
            },
            () => {
              markActivity(target);
            },
          );

          if (!interrupted) {
            ensureNewline();
            setAgentState(target, "done");
            sessions[target].sessionId = response.sessionId;
            transcript.push({ role: target, text: response.text });
            sessions[target].lastMessageIndex = transcript.length - 1;
          }
        } catch (err) {
          setAgentState(target, "error");
          if (!interrupted) printError(target, err);
        }
      } else {
        // Both agents — build prompts BEFORE starting either, then run in parallel
        const userMsgIdx = transcript.length - 1;
        const prompts = new Map<AgentName, string>();
        for (const target of targets) {
          prompts.set(target, buildPrompt(transcript, sessions[target]));
          setAgentState(target, "streaming");
        }
        refreshPrompt();

        const results = await Promise.allSettled(
          targets.map((target) =>
            sendToAgent(
              target,
              prompts.get(target)!,
              sessions[target],
              (delta) => {
                setAgentState(target, "streaming");
                streamDelta(target, delta);
              },
              (event) => {
                applyToolEvent(event);
                showToolUse(event);
                refreshPrompt();
              },
              () => {
                markActivity(target);
              },
            ).then((response) => ({ target, response })),
          ),
        );

        ensureNewline();

        // Add responses to transcript. Set lastMessageIndex to the user message
        // (the last thing they actually saw), so on the next turn each agent
        // gets the other's parallel response as missed context.
        for (let i = 0; i < targets.length; i++) {
          const target = targets[i];
          const result = results[i];
          if (result.status === "fulfilled") {
            const { response } = result.value;
            setAgentState(target, "done");
            sessions[target].sessionId = response.sessionId;
            transcript.push({ role: target, text: response.text });
            sessions[target].lastMessageIndex = userMsgIdx;
          } else {
            setAgentState(target, "error");
            if (!interrupted) printError(target, result.reason);
          }
        }
      }

      process.stdout.write("\n");
      processing = false;
      stopStatusLoop();
      resetAgentStates();
      refreshPrompt();
    }

    // Buffer rapid lines (multiline paste) into a single message.
    // After 50ms of no new lines, flush the buffer as one input.
    rl.on("line", (line) => {
      if (processing) {
        process.stdout.write(chalk.dim("\n  [busy: wait for current turn or press Ctrl+C]\n"));
        refreshPrompt();
        return;
      }

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
      stopStatusLoop();
      console.log(chalk.cyan("\nGoodbye!"));
      resolve();
    });
  });
}
