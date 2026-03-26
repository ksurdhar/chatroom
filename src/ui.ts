import * as readline from "node:readline";
import chalk from "chalk";
import type { AgentName, AgentSession, Message, ToolUseEvent } from "./types.js";
import { buildPrompt, parseInput } from "./transcript.js";
import { sendToAgent, hasActiveProcess, interruptAgent, interruptAll, terminateAll } from "./agents.js";

const COLORS: Record<AgentName, (s: string) => string> = {
  claude: chalk.magenta,
  codex: chalk.green,
};

const BOLD_COLORS: Record<AgentName, (s: string) => string> = {
  claude: chalk.magenta.bold,
  codex: chalk.green.bold,
};

const SPINNER_FRAMES = ["|", "/", "-", "\\"];
const DOUBLE_ESC_WINDOW_MS = 500;
const FORCE_EXIT_GRACE_MS = 250;
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const PASTE_FALLBACK_DEBOUNCE_MS = 150;
const TARGET_MODE_CYCLE = ["both", "claude", "codex"] as const;
type TargetMode = typeof TARGET_MODE_CYCLE[number];
const TARGET_MODE_COLORS: Record<TargetMode, (s: string) => string> = {
  both: chalk.cyan.bold,
  claude: chalk.magenta.bold,
  codex: chalk.green.bold,
};

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
    prompt: chalk.bold.white("you @both> "),
  });

  let processing = false;
  let targetMode: TargetMode = "both";
  let interruptedAgents = new Set<AgentName>();
  let spinnerIndex = 0;
  let statusTimer: ReturnType<typeof setInterval> | null = null;
  let rawModeEnabled = false;
  let exitInProgress = false;
  let lastEscapeAt = 0;
  let lastInterruptAt = 0;
  let isPasting = false;
  let bracketedPasteRaw = "";
  let flushBracketedPaste: ((text: string) => void) | null = null;
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

  function wasInterrupted(agent: AgentName): boolean {
    return interruptedAgents.has(agent);
  }

  function formatMode(mode: TargetMode): string {
    return TARGET_MODE_COLORS[mode](`@${mode}`);
  }

  function printTargetMode(mode: TargetMode) {
    ensureNewline();
    const colorFn = TARGET_MODE_COLORS[mode];
    process.stdout.write(colorFn(`  ▸ ${mode}`) + "\n");
    midLine = false;
  }

  function cycleTargetMode() {
    const idx = TARGET_MODE_CYCLE.indexOf(targetMode);
    targetMode = TARGET_MODE_CYCLE[(idx + 1) % TARGET_MODE_CYCLE.length];
  }

  function targetLabel(mode: TargetMode): string {
    return mode === "both" ? "both" : mode;
  }

  function selectedTargets(mode: TargetMode): AgentName[] {
    return mode === "both" ? ["claude", "codex"] : [mode];
  }

  function forceExit() {
    if (exitInProgress) return;
    exitInProgress = true;
    processing = false;
    stopStatusLoop();
    process.stdout.write("\x1b[?2004l");

    ensureNewline();
    process.stdout.write(chalk.yellow("\n  [exiting: terminating active agents...]\n"));
    midLine = false;

    terminateAll("SIGINT");

    setTimeout(() => {
      terminateAll("SIGKILL");
      rl.close();
      process.exit(0);
    }, FORCE_EXIT_GRACE_MS);
  }

  function interruptSelected(mode: TargetMode) {
    if (!processing) {
      ensureNewline();
      process.stdout.write(chalk.dim("\n  [idle: nothing to interrupt]\n\n"));
      midLine = false;
      refreshPrompt();
      return;
    }

    const targets = selectedTargets(mode);
    let interruptedCount = 0;
    for (const agent of targets) {
      if (!hasActiveProcess(agent)) continue;
      const didInterrupt = mode === "both" ? true : interruptAgent(agent);
      if (didInterrupt) {
        interruptedAgents.add(agent);
        interruptedCount += 1;
      }
    }

    if (mode === "both" && interruptedCount > 0) {
      interruptAll();
    }

    ensureNewline();
    if (interruptedCount > 0) {
      process.stdout.write(
        chalk.yellow(`\n  [interrupt sent to ${targetLabel(mode)}]\n\n`),
      );
    } else {
      process.stdout.write(
        chalk.dim(`\n  [no active process for ${targetLabel(mode)}]\n\n`),
      );
    }
    midLine = false;
    refreshPrompt();
  }

  function handleInterruptShortcut() {
    const now = Date.now();
    if (now - lastInterruptAt < 80) return;
    lastInterruptAt = now;
    lastEscapeAt = 0;
    interruptSelected(targetMode);
  }

  function promptText(): string {
    if (isPasting) return `${chalk.bold.white("you")} ${chalk.yellow("[pasting...]")}${chalk.bold.white(">")} `;
    if (!processing) return `${chalk.bold.white("you")} ${formatMode(targetMode)}${chalk.bold.white(">")} `;

    const statuses = (["claude", "codex"] as AgentName[])
      .map((agent) => formatAgentStatus(agent))
      .filter((s): s is string => Boolean(s));

    const spinner = SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length];
    if (statuses.length === 0) {
      return `${chalk.bold.white("you")} ${formatMode(targetMode)} ${chalk.dim(`[${spinner} working]`)}${chalk.bold.white(">")} `;
    }

    return `${chalk.bold.white("you")} ${formatMode(targetMode)} ${chalk.dim(`[${spinner} ${statuses.join(" | ")}]`)}${chalk.bold.white(">")} `;
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

  readline.emitKeypressEvents(process.stdin, rl);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    rawModeEnabled = true;
  }

  // Enable bracketed paste so terminals wrap pasted text in markers
  process.stdout.write("\x1b[?2004h");

  const onKeypress = (
    str: string,
    key?: { ctrl?: boolean; name?: string; shift?: boolean; sequence?: string },
  ) => {
    // Bracketed paste detection — must run before any other key handling
    const seq = key?.sequence ?? str;
    if (seq === PASTE_START) {
      isPasting = true;
      bracketedPasteRaw = "";
      return;
    }
    if (seq === PASTE_END) {
      isPasting = false;
      const full = bracketedPasteRaw;
      bracketedPasteRaw = "";
      if (!full.trim() || !flushBracketedPaste) {
        refreshPrompt();
        return;
      }
      if (processing) {
        ensureNewline();
        process.stdout.write(
          chalk.dim("\n  [busy: wait, press Ctrl+C to interrupt, or Esc Esc to exit]\n"),
        );
        midLine = false;
        refreshPrompt();
        return;
      }
      flushBracketedPaste(full);
      return;
    }
    if (isPasting) {
      // Buffer raw characters (including newlines) during paste
      bracketedPasteRaw += str;
      return;
    }

    const isEscape = key?.name === "escape" || str === "\u001b";
    if (isEscape) {
      const now = Date.now();
      if (now - lastEscapeAt <= DOUBLE_ESC_WINDOW_MS) {
        lastEscapeAt = 0;
        forceExit();
      } else {
        lastEscapeAt = now;
        ensureNewline();
        process.stdout.write(chalk.dim("\n  [press Esc again quickly to exit]\n\n"));
        midLine = false;
        refreshPrompt();
      }
      return;
    }

    if (key?.shift && key.name === "tab") {
      cycleTargetMode();
      refreshPrompt();
      return;
    }

    const isCtrlC = (key?.ctrl && key.name === "c") || str === "\u0003";
    if (!isCtrlC) return;
    handleInterruptShortcut();
  };

  process.stdin.on("keypress", onKeypress);

  const onSigInt = () => {
    handleInterruptShortcut();
  };

  const onRlSigInt = () => {
    handleInterruptShortcut();
  };

  refreshPrompt();

  // SIGINT fallback (non-raw/non-TTY environments)
  process.on("SIGINT", onSigInt);

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
        forceExit();
        return;
      }

      processing = true;
      interruptedAgents = new Set<AgentName>();
      lastWriter = null;
      resetAgentStates();
      startStatusLoop();
      refreshPrompt();

      const parsed = parseInput(trimmed, targetMode);
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
          if (wasInterrupted(agent)) break;
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

            if (wasInterrupted(agent)) break;

            ensureNewline();
            setAgentState(agent, "done");
            sessions[agent].sessionId = response.sessionId;
            transcript.push({ role: agent, text: response.text });
            sessions[agent].lastMessageIndex = transcript.length - 1;
          } catch (err) {
            if (wasInterrupted(agent)) {
              setAgentState(agent, "done");
            } else {
              setAgentState(agent, "error");
              printError(agent, err);
            }
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

          if (!wasInterrupted(target)) {
            ensureNewline();
            setAgentState(target, "done");
            sessions[target].sessionId = response.sessionId;
            transcript.push({ role: target, text: response.text });
            sessions[target].lastMessageIndex = transcript.length - 1;
          }
        } catch (err) {
          if (wasInterrupted(target)) {
            setAgentState(target, "done");
          } else {
            setAgentState(target, "error");
            printError(target, err);
          }
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
            if (wasInterrupted(target)) {
              setAgentState(target, "done");
              continue;
            }
            const { response } = result.value;
            setAgentState(target, "done");
            sessions[target].sessionId = response.sessionId;
            transcript.push({ role: target, text: response.text });
            sessions[target].lastMessageIndex = userMsgIdx;
          } else {
            if (wasInterrupted(target)) {
              setAgentState(target, "done");
            } else {
              setAgentState(target, "error");
              printError(target, result.reason);
            }
          }
        }
      }

      process.stdout.write("\n");
      processing = false;
      stopStatusLoop();
      resetAgentStates();
      refreshPrompt();
    }

    flushBracketedPaste = (text: string) => processInput(text);

    // Buffer rapid lines (multiline paste fallback for terminals without
    // bracketed paste support). Debounce at 150ms to catch pasted blocks.
    rl.on("line", (line) => {
      // During bracketed paste, keypress handler collects raw chars — skip line processing
      if (isPasting) return;

      if (processing) {
        const trimmed = line.trim();
        if (trimmed === "/quit" || trimmed === "/exit") {
          forceExit();
          return;
        }
        process.stdout.write(
          chalk.dim("\n  [busy: wait, press Ctrl+C to interrupt, or Esc Esc to exit]\n"),
        );
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
      }, PASTE_FALLBACK_DEBOUNCE_MS);
    });

    rl.on("SIGINT", onRlSigInt);

    rl.on("close", () => {
      stopStatusLoop();
      process.stdout.write("\x1b[?2004l");
      process.off("SIGINT", onSigInt);
      process.stdin.off("keypress", onKeypress);
      rl.off("SIGINT", onRlSigInt);
      if (rawModeEnabled && process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      console.log(chalk.cyan("\nGoodbye!"));
      resolve();
    });
  });
}
