import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export async function ensureLogsDir(logsDir: string) {
  await mkdir(logsDir, { recursive: true });
}

export function buildLogPath(name: string, logsDir: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return resolve(logsDir, `${name}-${timestamp}.log`);
}
