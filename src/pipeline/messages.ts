import { join } from "node:path";
import { mkdir, readdir, rm } from "node:fs/promises";
import { hiveRoot } from "../ctx/store.ts";
import { MessageEnvelopeSchema, type MessageEnvelope, type StageMetrics } from "./schema.ts";

// ── Stage name backward compatibility ────────────────────────────────

/** Maps legacy stage names to their current names. */
const STAGE_NAME_ALIASES: Record<string, string> = {
  scan: "ingest",
  gather: "ingest",
  inject: "prepare",
  mine: "extract",
  analyze: "extract",
  collect: "summarize",
};

/** Returns the canonical stage name, mapping legacy names to current ones. */
export function canonicalStageName(name: string): string {
  return STAGE_NAME_ALIASES[name] ?? name;
}

/** Returns all legacy names that map to the given canonical name. */
function legacyNamesFor(canonical: string): string[] {
  const names: string[] = [];
  for (const [old, current] of Object.entries(STAGE_NAME_ALIASES)) {
    if (current === canonical) names.push(old);
  }
  return names;
}

// ── Paths ────────────────────────────────────────────────────────────

const MESSAGES_DIR = join(hiveRoot(), "messages");

export function messagesRoot(): string {
  return MESSAGES_DIR;
}

export function executionDir(executionId: string): string {
  return join(MESSAGES_DIR, executionId);
}

function messagePath(executionId: string, stageName: string): string {
  return join(executionDir(executionId), `${stageName}.out.json`);
}

function manifestPath(executionId: string): string {
  return join(executionDir(executionId), "manifest.json");
}

// ── Directory setup ──────────────────────────────────────────────────

export async function ensureMessageDirs(): Promise<void> {
  await mkdir(MESSAGES_DIR, { recursive: true });
}

export async function createExecutionDir(executionId: string): Promise<string> {
  const dir = executionDir(executionId);
  await mkdir(dir, { recursive: true });
  return dir;
}

// ── Message I/O ──────────────────────────────────────────────────────

export async function writeMessage(
  executionId: string,
  stageName: string,
  data: unknown,
  metrics?: StageMetrics,
): Promise<void> {
  const envelope: MessageEnvelope = {
    timestamp: new Date().toISOString(),
    stageName,
    data,
    metrics,
  };
  await Bun.write(messagePath(executionId, stageName), JSON.stringify(envelope, null, 2));
}

export async function readMessage(executionId: string, stageName: string): Promise<unknown> {
  const path = messagePath(executionId, stageName);
  const file = Bun.file(path);
  if (await file.exists()) {
    const envelope = MessageEnvelopeSchema.parse(JSON.parse(await file.text()));
    return envelope.data;
  }
  // Fallback: try legacy stage name files
  for (const legacy of legacyNamesFor(stageName)) {
    const legacyFile = Bun.file(messagePath(executionId, legacy));
    if (await legacyFile.exists()) {
      const envelope = MessageEnvelopeSchema.parse(JSON.parse(await legacyFile.text()));
      return envelope.data;
    }
  }
  throw new Error(`Message not found: ${stageName} for execution ${executionId}`);
}

export async function messageExists(executionId: string, stageName: string): Promise<boolean> {
  if (await Bun.file(messagePath(executionId, stageName)).exists()) return true;
  // Fallback: check legacy stage name files
  for (const legacy of legacyNamesFor(stageName)) {
    if (await Bun.file(messagePath(executionId, legacy)).exists()) return true;
  }
  return false;
}

// ── Manifest I/O ─────────────────────────────────────────────────────

export async function writeManifest(executionId: string, manifest: unknown): Promise<void> {
  await Bun.write(manifestPath(executionId), JSON.stringify(manifest, null, 2));
}

export async function readManifest(executionId: string): Promise<unknown> {
  const raw = await Bun.file(manifestPath(executionId)).text();
  return JSON.parse(raw);
}

// ── List executions ──────────────────────────────────────────────────

export async function listExecutionIds(): Promise<string[]> {
  try {
    const entries = await readdir(MESSAGES_DIR, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

// ── Cleanup ──────────────────────────────────────────────────────────

export async function cleanupMessages(executionId: string): Promise<void> {
  await rm(executionDir(executionId), { recursive: true, force: true });
}
