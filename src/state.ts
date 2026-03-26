import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  AgentName,
  AgentSession,
  Message,
  PendingTurn,
  StateSnapshotV1,
  TargetMode,
} from "./types.js";

export const STATE_SCHEMA_VERSION = 1;

export function getDefaultStatePath(cwd = process.cwd()): string {
  return path.join(cwd, ".chatroom", "state.json");
}

export function createStateSnapshot(
  transcript: Message[],
  sessions: Record<AgentName, AgentSession>,
  targetMode: TargetMode,
  pendingTurn: PendingTurn | null,
): StateSnapshotV1 {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    transcript: transcript.map((message) => ({ ...message })),
    sessions: {
      claude: { ...sessions.claude },
      codex: { ...sessions.codex },
    },
    targetMode,
    pendingTurn: pendingTurn
      ? {
        message: pendingTurn.message,
        targets: [...pendingTurn.targets],
      }
      : null,
  };
}

export async function saveStateSnapshot(
  snapshot: StateSnapshotV1,
  statePath = getDefaultStatePath(),
): Promise<void> {
  const dir = path.dirname(statePath);
  await mkdir(dir, { recursive: true });
  const tmpPath = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, JSON.stringify(snapshot, null, 2), "utf8");
  await rename(tmpPath, statePath);
}

export async function loadStateSnapshot(statePath: string): Promise<StateSnapshotV1> {
  const text = await readFile(statePath, "utf8");
  const parsed: unknown = JSON.parse(text);
  const snapshot = parseSnapshot(parsed, statePath);
  // Clean up the state file after a successful load
  await unlink(statePath).catch(() => {});
  return snapshot;
}

function parseSnapshot(raw: unknown, sourcePath: string): StateSnapshotV1 {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid state file at ${sourcePath}: expected object`);
  }
  const obj = raw as Record<string, unknown>;

  if (obj.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported state schema in ${sourcePath}: ${String(obj.schemaVersion)}`,
    );
  }

  if (!Array.isArray(obj.transcript)) {
    throw new Error(`Invalid state file at ${sourcePath}: transcript must be an array`);
  }

  const transcript = obj.transcript.map((message, i) => parseMessage(message, sourcePath, i));
  const sessions = parseSessions(obj.sessions, sourcePath);
  const targetMode = parseTargetMode(obj.targetMode, sourcePath);
  const pendingTurn = parsePendingTurn(obj.pendingTurn, sourcePath);
  const savedAt = typeof obj.savedAt === "string" ? obj.savedAt : new Date().toISOString();

  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    savedAt,
    transcript,
    sessions,
    targetMode,
    pendingTurn,
  };
}

function parseMessage(raw: unknown, sourcePath: string, index: number): Message {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid state file at ${sourcePath}: message ${index} must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (
    obj.role !== "user" &&
    obj.role !== "claude" &&
    obj.role !== "codex"
  ) {
    throw new Error(`Invalid state file at ${sourcePath}: message ${index} has bad role`);
  }
  if (typeof obj.text !== "string") {
    throw new Error(`Invalid state file at ${sourcePath}: message ${index} text must be string`);
  }
  return {
    role: obj.role,
    text: obj.text,
  };
}

function parseSessions(raw: unknown, sourcePath: string): Record<AgentName, AgentSession> {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid state file at ${sourcePath}: sessions missing`);
  }
  const obj = raw as Record<string, unknown>;
  return {
    claude: parseSession("claude", obj.claude, sourcePath),
    codex: parseSession("codex", obj.codex, sourcePath),
  };
}

function parseSession(
  name: AgentName,
  raw: unknown,
  sourcePath: string,
): AgentSession {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid state file at ${sourcePath}: ${name} session missing`);
  }
  const obj = raw as Record<string, unknown>;
  if (obj.name !== name) {
    throw new Error(`Invalid state file at ${sourcePath}: ${name} session has bad name`);
  }
  if (obj.sessionId !== null && typeof obj.sessionId !== "string") {
    throw new Error(`Invalid state file at ${sourcePath}: ${name} sessionId must be string|null`);
  }
  if (typeof obj.lastMessageIndex !== "number") {
    throw new Error(`Invalid state file at ${sourcePath}: ${name} lastMessageIndex must be number`);
  }
  return {
    name,
    sessionId: obj.sessionId,
    lastMessageIndex: obj.lastMessageIndex,
  };
}

function parseTargetMode(raw: unknown, sourcePath: string): TargetMode {
  if (raw === "both" || raw === "claude" || raw === "codex") return raw;
  throw new Error(`Invalid state file at ${sourcePath}: bad targetMode`);
}

function parsePendingTurn(raw: unknown, sourcePath: string): PendingTurn | null {
  if (raw === null || raw === undefined) return null;
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid state file at ${sourcePath}: pendingTurn must be object|null`);
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.message !== "string") {
    throw new Error(`Invalid state file at ${sourcePath}: pendingTurn.message must be string`);
  }
  if (!Array.isArray(obj.targets)) {
    throw new Error(`Invalid state file at ${sourcePath}: pendingTurn.targets must be array`);
  }

  const targets = obj.targets.filter(
    (target): target is AgentName => target === "claude" || target === "codex",
  );
  if (targets.length === 0 || targets.length !== obj.targets.length) {
    throw new Error(`Invalid state file at ${sourcePath}: pendingTurn.targets has invalid values`);
  }

  return {
    message: obj.message,
    targets,
  };
}
