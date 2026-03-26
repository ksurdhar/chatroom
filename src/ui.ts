import * as readline from "node:readline";
import chalk from "chalk";
import type {
  AgentName,
  AgentSession,
  Message,
  PendingTurn,
  StateSnapshotV1,
  TargetMode,
  ToolUseEvent,
} from "./types.js";
import { buildPrompt, parseInput } from "./transcript.js";
import { sendToAgent, hasActiveProcess, interruptAgent, interruptAll, terminateAll } from "./agents.js";
import { createStateSnapshot } from "./state.js";

// Vibrant colors for prompts, headers, and UI chrome
const CLAUDE_COLOR = "#FF8C00";
const CODEX_COLOR = "#1E90FF";
// Lighter (50%) versions for streamed agent output
const CLAUDE_COLOR_LIGHT = "#FFC680";
const CODEX_COLOR_LIGHT = "#8FC8FF";

const COLORS: Record<AgentName, (s: string) => string> = {
  claude: chalk.hex(CLAUDE_COLOR_LIGHT),
  codex: chalk.hex(CODEX_COLOR_LIGHT),
};

const BOLD_COLORS: Record<AgentName, (s: string) => string> = {
  claude: chalk.hex(CLAUDE_COLOR).bold,
  codex: chalk.hex(CODEX_COLOR).bold,
};

const FORCE_EXIT_GRACE_MS = 250;
const SPINNER_FRAMES = ["|", "/", "-", "\\"];
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const PASTE_FALLBACK_DEBOUNCE_MS = 150;
const TARGET_MODE_CYCLE = ["both", "claude", "codex"] as const;
const TARGET_MODE_COLORS: Record<TargetMode, (s: string) => string> = {
  both: chalk.cyan.bold,
  claude: chalk.hex(CLAUDE_COLOR).bold,
  codex: chalk.hex(CODEX_COLOR).bold,
};

interface AgentUiState {
  state: "idle" | "streaming" | "tool_running" | "done" | "error";
  inFlightTools: number;
  activeTool: string | null;
  lastActivityAt: number;
  startedAt: number;
  finishedAt: number;
}

interface ChatLoopOptions {
  initialTargetMode?: TargetMode;
  initialPendingTurn?: PendingTurn | null;
  restoredAt?: string | null;
}

type ChatLoopResult =
  | { kind: "exit" }
  | { kind: "rebuild"; snapshot: StateSnapshotV1 };

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
      startedAt: now,
      finishedAt: 0,
    },
    codex: {
      state: "idle",
      inFlightTools: 0,
      activeTool: null,
      lastActivityAt: now,
      startedAt: now,
      finishedAt: 0,
    },
  };
}

function formatClock(timestamp: string | null | undefined): string {
  if (!timestamp) return "unknown time";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "unknown time";
  return date.toLocaleTimeString([], { hour12: false });
}

function transcriptColor(role: Message["role"]): (s: string) => string {
  if (role === "claude") return chalk.hex(CLAUDE_COLOR_LIGHT);
  if (role === "codex") return chalk.hex(CODEX_COLOR_LIGHT);
  return chalk.white;
}

function printRestoredTranscript(
  transcript: Message[],
  restoredAt: string | null | undefined,
  pendingTurn: PendingTurn | null,
) {
  process.stdout.write(chalk.cyan(`\n  [reloaded at ${formatClock(restoredAt)}]\n`));
  if (transcript.length === 0) {
    process.stdout.write(chalk.dim("  [no prior transcript]\n\n"));
  } else {
    for (const msg of transcript) {
      const color = transcriptColor(msg.role);
      process.stdout.write(color(`[${msg.role}] ${msg.text}\n`));
    }
    process.stdout.write("\n");
  }

  if (pendingTurn) {
    process.stdout.write(
      chalk.yellow("  [last turn may be incomplete; run /retry to resend it]\n\n"),
    );
  }
}

export async function runChatLoop(
  transcript: Message[],
  sessions: Record<AgentName, AgentSession>,
  options: ChatLoopOptions = {},
): Promise<ChatLoopResult> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.bold.white("you @both> "),
  });

  let processing = false;
  let targetMode: TargetMode = options.initialTargetMode ?? "both";
  let pendingTurn: PendingTurn | null = options.initialPendingTurn ?? null;
  let rebuildSnapshot: StateSnapshotV1 | null = null;
  let interruptedAgents = new Set<AgentName>();
  let spinnerIndex = 0;
  let statusTimer: ReturnType<typeof setInterval> | null = null;
  let statusVisible = false;
  let statusText = "";
  let rawModeEnabled = false;
  let exitInProgress = false;
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
    const st = agentStates[agent];
    const wasActive = st.state === "streaming" || st.state === "tool_running";
    const becomingActive = state === "streaming" || state === "tool_running";
    if (becomingActive && !wasActive) {
      st.startedAt = Date.now();
      st.finishedAt = 0;
    }
    if (state === "done" || state === "error") {
      st.finishedAt = Date.now();
    }
    st.state = state;
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

  function wasInterrupted(agent: AgentName): boolean {
    return interruptedAgents.has(agent);
  }

  function formatMode(mode: TargetMode): string {
    return TARGET_MODE_COLORS[mode](`@${mode}`);
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

  function formatElapsed(ms: number): string {
    const sec = Math.floor(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.floor(sec / 60);
    const remainSec = sec % 60;
    return `${min}m${remainSec}s`;
  }

  function formatAgentStatus(agent: AgentName): string | null {
    const st = agentStates[agent];
    if (st.state === "idle") return null;

    const endTime = st.finishedAt || Date.now();
    const elapsed = formatElapsed(endTime - st.startedAt);

    if (st.state === "error") return `${agent}:error after ${elapsed}`;
    if (st.state === "done") return `${agent}:done in ${elapsed}`;

    const silenceSec = Math.floor((Date.now() - st.lastActivityAt) / 1000);

    const action = st.state === "tool_running"
      ? `running ${st.activeTool ?? "tool"}`
      : "working";

    let suffix = "";
    if (silenceSec >= 60) suffix = " stalled?";
    else if (silenceSec >= 15) suffix = " still-working";

    return `${agent}:${action} ${elapsed}${suffix}`;
  }

  function clearStatusLine() {
    if (!statusVisible) return;
    // Erase the status text on the current line
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    statusVisible = false;
    statusText = "";
    midLine = false;
  }

  function renderStatusLine() {
    if (!processing) return;

    const statuses = (["claude", "codex"] as AgentName[])
      .map((agent) => formatAgentStatus(agent))
      .filter((s): s is string => Boolean(s));
    const spinner = SPINNER_FRAMES[spinnerIndex % SPINNER_FRAMES.length];
    const nextStatus = statuses.length === 0
      ? `${spinner} working`
      : `${spinner} ${statuses.join(" | ")}`;

    if (statusVisible && nextStatus === statusText) return;

    if (statusVisible) {
      // Overwrite existing status line in place
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
    } else if (midLine) {
      // Agent output is mid-line — drop to a new line for status
      process.stdout.write("\n");
    }
    process.stdout.write(chalk.dim(`  [${nextStatus}]`));
    statusVisible = true;
    statusText = nextStatus;
    midLine = true;
  }

  function redrawStatusLine() {
    if (!processing) return;
    renderStatusLine();
  }

  function startStatusLoop() {
    if (statusTimer) clearInterval(statusTimer);
    spinnerIndex = 0;
    statusTimer = setInterval(() => {
      spinnerIndex = (spinnerIndex + 1) % SPINNER_FRAMES.length;
      redrawStatusLine();
    }, 200);
    redrawStatusLine();
  }

  function stopStatusLoop() {
    if (!statusTimer) return;
    clearInterval(statusTimer);
    statusTimer = null;
  }

  function writeStreamDelta(agent: AgentName, text: string) {
    clearStatusLine();
    streamDelta(agent, text);
    // Codex emits full message blocks (not token deltas), so force a line break
    // to reopen the dedicated status lane while other agents may still be running.
    if (agent === "codex" && !text.endsWith("\n")) {
      process.stdout.write("\n");
      midLine = false;
    }
    redrawStatusLine();
  }

  function writeToolUse(event: ToolUseEvent) {
    clearStatusLine();
    showToolUse(event);
    redrawStatusLine();
  }

  function writeAgentError(agent: AgentName, err: unknown) {
    clearStatusLine();
    printError(agent, err);
    redrawStatusLine();
  }

  function getStateSnapshot(): StateSnapshotV1 {
    return createStateSnapshot(transcript, sessions, targetMode, pendingTurn);
  }

  function resetChatsForMode(mode: TargetMode) {
    if (mode === "both") {
      transcript.length = 0;
      pendingTurn = null;
    }

    for (const agent of selectedTargets(mode)) {
      sessions[agent].sessionId = null;
      sessions[agent].lastMessageIndex = mode === "both" ? -1 : transcript.length - 1;
    }
  }

  function gracefulShutdown() {
    if (exitInProgress) return;
    exitInProgress = true;
    processing = false;
    stopStatusLoop();
    clearStatusLine();

    ensureNewline();
    process.stdout.write(chalk.yellow("\n  [shutting down...]\n"));
    midLine = false;

    terminateAll("SIGINT");

    setTimeout(() => {
      terminateAll("SIGKILL");
      rl.close();
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

    if (exitInProgress) {
      terminateAll("SIGKILL");
      process.exit(1);
      return;
    }

    if (!processing) {
      gracefulShutdown();
      return;
    }

    interruptSelected(targetMode);
  }

  function promptText(): string {
    if (isPasting) return `${chalk.bold.white("you")} ${chalk.yellow("[pasting...]")}${chalk.bold.white(">")} `;
    return `${chalk.bold.white("you")} ${formatMode(targetMode)}${chalk.bold.white(">")} `;
  }

  function refreshPrompt() {
    rl.setPrompt(promptText());
    if (!processing) {
      rl.prompt(true);
    }
  }

  function finishProcessing() {
    stopStatusLoop();
    clearStatusLine();
    process.stdout.write("\n");
    processing = false;
    resetAgentStates();
    refreshPrompt();
  }

  readline.emitKeypressEvents(process.stdin, rl);
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(true);
      rawModeEnabled = true;
    } catch {
      process.stdout.write(
        chalk.yellow("  [warning: raw mode unavailable - input may behave differently]\n"),
      );
    }
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
          chalk.dim("\n  [busy: wait, or press Ctrl+C to interrupt]\n"),
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

  const onSigWinch = () => {
    clearStatusLine();
    redrawStatusLine();
    if (!processing) {
      refreshPrompt();
    }
  };

  if (options.restoredAt) {
    printRestoredTranscript(transcript, options.restoredAt, pendingTurn);
  }

  refreshPrompt();

  // SIGINT fallback (non-raw/non-TTY environments)
  process.on("SIGINT", onSigInt);
  process.on("SIGWINCH", onSigWinch);

  return new Promise<ChatLoopResult>((resolve) => {
    let pasteBuffer: string[] = [];
    let pasteTimer: ReturnType<typeof setTimeout> | null = null;

    async function processInput(fullInput: string) {
      const trimmed = fullInput.trim();
      if (!trimmed) {
        refreshPrompt();
        return;
      }

      if (trimmed === "/rebuild") {
        rebuildSnapshot = getStateSnapshot();
        ensureNewline();
        process.stdout.write(chalk.cyan("\n  [rebuild requested]\n"));
        process.stdout.write(chalk.dim("  [running build and relaunching...]\n\n"));
        midLine = false;
        rl.close();
        return;
      }

      if (trimmed === "/clear" || trimmed === "/new") {
        resetChatsForMode(targetMode);
        pendingTurn = null;
        ensureNewline();
        process.stdout.write(
          chalk.cyan(`\n  [started new chat for ${targetLabel(targetMode)}]\n\n`),
        );
        midLine = false;
        refreshPrompt();
        return;
      }

      if (trimmed === "/quit" || trimmed === "/exit") {
        gracefulShutdown();
        return;
      }

      if (trimmed === "/retry" && !pendingTurn) {
        ensureNewline();
        process.stdout.write(chalk.dim("\n  [no interrupted turn to retry]\n\n"));
        midLine = false;
        refreshPrompt();
        return;
      }

      processing = true;
      interruptedAgents = new Set<AgentName>();
      lastWriter = null;
      resetAgentStates();
      startStatusLoop();

      const isRetry = trimmed === "/retry" && pendingTurn != null;
      const parsed = isRetry
        ? { targets: [...pendingTurn!.targets], message: pendingTurn!.message }
        : parseInput(trimmed, targetMode);
      const { targets, message } = parsed;

      if (isRetry) {
        clearStatusLine();
        process.stdout.write(chalk.dim(`  [retrying ${targets.join(", ")}]\n`));
        redrawStatusLine();
      }

      // /respond N — agents take turns responding to each other
      if (parsed.respond) {
        const rounds = parsed.respond;
        const first = parsed.respondStart ?? "claude";
        const second: AgentName = first === "claude" ? "codex" : "claude";
        const order: AgentName[] = [first, second];
        clearStatusLine();
        process.stdout.write(chalk.dim(`  [agents responding for ${rounds} rounds...]\n`));
        redrawStatusLine();

        for (let i = 0; i < rounds; i++) {
          const scheduledAgent = order[i % 2];
          const fallbackAgent: AgentName = scheduledAgent === "claude" ? "codex" : "claude";
          let agent = scheduledAgent;
          if (wasInterrupted(scheduledAgent) && wasInterrupted(fallbackAgent)) break;

          let prompt = buildPrompt(transcript, sessions[agent]);
          if (!prompt.trim()) {
            agent = fallbackAgent;
            if (!wasInterrupted(agent)) {
              prompt = buildPrompt(transcript, sessions[agent]);
            }
          }

          if (!prompt.trim() || wasInterrupted(agent)) {
            clearStatusLine();
            process.stdout.write(chalk.dim("  [nothing new for either agent to respond to]\n"));
            redrawStatusLine();
            break;
          }

          setAgentState(agent, "streaming");

          try {
            const response = await sendToAgent(
              agent,
              prompt,
              sessions[agent],
              (delta) => {
                setAgentState(agent, "streaming");
                writeStreamDelta(agent, delta);
              },
              (event) => {
                applyToolEvent(event);
                writeToolUse(event);
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
              writeAgentError(agent, err);
            }
            break;
          }
        }

        finishProcessing();
        return;
      }

      if (!isRetry) {
        pendingTurn = { message, targets: [...targets] };
        transcript.push({ role: "user", text: message });
      }

      if (targets.length === 1) {
        // Single agent — straightforward
        const target = targets[0];
        let completed = false;
        const prompt = buildPrompt(transcript, sessions[target]);
        setAgentState(target, "streaming");

        try {
          const response = await sendToAgent(
            target,
            prompt,
            sessions[target],
            (delta) => {
              setAgentState(target, "streaming");
              writeStreamDelta(target, delta);
            },
            (event) => {
              applyToolEvent(event);
              writeToolUse(event);
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
            completed = true;
          }
        } catch (err) {
          if (wasInterrupted(target)) {
            setAgentState(target, "done");
          } else {
            setAgentState(target, "error");
            writeAgentError(target, err);
          }
        }

        if (completed) {
          pendingTurn = null;
        }
      } else {
        // Both agents — build prompts BEFORE starting either, then run in parallel
        const userMsgIdx = transcript.length - 1;
        let completedCount = 0;
        const prompts = new Map<AgentName, string>();
        for (const target of targets) {
          prompts.set(target, buildPrompt(transcript, sessions[target]));
          setAgentState(target, "streaming");
        }

        const results = await Promise.allSettled(
          targets.map((target) =>
            sendToAgent(
              target,
              prompts.get(target)!,
              sessions[target],
              (delta) => {
                setAgentState(target, "streaming");
                writeStreamDelta(target, delta);
              },
              (event) => {
                applyToolEvent(event);
                writeToolUse(event);
              },
              () => {
                markActivity(target);
              },
            ).then((response) => {
              setAgentState(target, "done");
              return { target, response };
            }).catch((error) => {
              if (wasInterrupted(target)) {
                setAgentState(target, "done");
              } else {
                setAgentState(target, "error");
              }
              throw error;
            }),
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
            if (wasInterrupted(target)) continue;
            const { response } = result.value;
            setAgentState(target, "done");
            sessions[target].sessionId = response.sessionId;
            transcript.push({ role: target, text: response.text });
            sessions[target].lastMessageIndex = userMsgIdx;
            completedCount += 1;
          } else {
            if (!wasInterrupted(target)) {
              writeAgentError(target, result.reason);
            }
          }
        }

        if (completedCount === targets.length) {
          pendingTurn = null;
        } else {
          // Narrow pendingTurn to only the agents that failed/were interrupted
          const completedTargets = new Set<AgentName>();
          for (let i = 0; i < targets.length; i++) {
            if (results[i].status === "fulfilled" && !wasInterrupted(targets[i])) {
              completedTargets.add(targets[i]);
            }
          }
          const failedTargets = targets.filter((t) => !completedTargets.has(t));
          if (failedTargets.length > 0) {
            pendingTurn = { message, targets: failedTargets };
            clearStatusLine();
            process.stdout.write(
              chalk.dim(`  [/retry available for: ${failedTargets.join(", ")}]\n`),
            );
            redrawStatusLine();
          } else {
            pendingTurn = null;
          }
        }
      }

      finishProcessing();
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
          gracefulShutdown();
          return;
        }
        if (trimmed === "/rebuild") {
          process.stdout.write(
            chalk.dim("\n  [busy: interrupt first, then run /rebuild]\n"),
          );
          refreshPrompt();
          return;
        }
        process.stdout.write(
          chalk.dim("\n  [busy: wait, or press Ctrl+C to interrupt]\n"),
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
      process.stdout.write("\x1b[?2004l");
      process.off("SIGINT", onSigInt);
      process.off("SIGWINCH", onSigWinch);
      process.stdin.off("keypress", onKeypress);
      rl.off("SIGINT", onRlSigInt);
      stopStatusLoop();
      clearStatusLine();
      if (rawModeEnabled && process.stdin.isTTY) {
        try {
          process.stdin.setRawMode(false);
        } catch {
          // PTY may already be torn down — ignore
        }
      }
      if (rebuildSnapshot) {
        resolve({ kind: "rebuild", snapshot: rebuildSnapshot });
        return;
      }
      console.log(chalk.cyan("\nGoodbye!"));
      resolve({ kind: "exit" });
    });
  });
}
