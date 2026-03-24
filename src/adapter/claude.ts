import { appendFile } from "node:fs/promises";
import { ensureLogsDir, buildLogPath } from "./logs.ts";

export interface ClaudeResult {
  result: string;
  duration_ms: number;
  duration_api_ms: number;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
}

export interface ClaudeInstance {
  name: string;
  logPath: string;
  completed: Promise<{ exitCode: number; result?: ClaudeResult }>;
}

export interface SpawnClaudeOptions {
  name: string;
  prompt: string;
  cwd?: string;
  model?: string;
  allowedTools?: string[];
  logsDir?: string;
}

// Stream message types from Claude CLI
interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface StreamMessage {
  type: string;
  message?: { content?: ContentBlock[] };
  is_error?: boolean;
  result?: string;
  duration_ms?: number;
  duration_api_ms?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
}

function isStreamMessage(value: unknown): value is StreamMessage {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  return typeof value.type === "string";
}

export async function spawnClaude(options: SpawnClaudeOptions): Promise<ClaudeInstance> {
  if (Bun.which("claude") === null) {
    throw new Error("'claude' CLI not found in PATH. Install it first.");
  }

  const logsDir = options.logsDir ?? "logs";
  await ensureLogsDir(logsDir);
  const logPath = buildLogPath(options.name, logsDir);

  const env = { ...process.env };
  // Prevent recursive Claude Code invocations when spawned from within Claude Code
  delete env.CLAUDECODE;

  const args = ["claude", "-p", "--no-session-persistence", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
  if (options.model !== undefined) {
    args.push("--model", options.model);
  }
  if (options.allowedTools !== undefined && options.allowedTools.length > 0) {
    args.push("--allowedTools", options.allowedTools.join(","));
  }
  args.push("--", options.prompt);

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "inherit",
    cwd: options.cwd,
    env,
  });

  const completed = processStream(proc, logPath);

  return {
    name: options.name,
    logPath,
    completed,
  };
}

function parseResultFromMsg(msg: StreamMessage): ClaudeResult | undefined {
  if (msg.type !== "result" || msg.result === undefined || msg.usage === undefined) return undefined;
  return {
    result: msg.result,
    duration_ms: msg.duration_ms ?? 0,
    duration_api_ms: msg.duration_api_ms ?? 0,
    total_cost_usd: msg.total_cost_usd ?? 0,
    usage: {
      input_tokens: msg.usage.input_tokens,
      output_tokens: msg.usage.output_tokens,
      cache_creation_input_tokens: msg.usage.cache_creation_input_tokens,
      cache_read_input_tokens: msg.usage.cache_read_input_tokens,
    },
  };
}

async function processStream(
  proc: ReturnType<typeof Bun.spawn>,
  logPath: string,
): Promise<{ exitCode: number; result?: ClaudeResult }> {
  let claudeResult: ClaudeResult | undefined;
  let lastWrittenLength = 0;
  const seenToolUseIds = new Set<string>();

  // Create the log file immediately so tail -f can attach
  await Bun.write(logPath, "");

  if (proc.stdout == null || typeof proc.stdout === "number") {
    throw new Error("Expected stdout to be a ReadableStream");
  }
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done === true) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line.trim() === "") continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isStreamMessage(parsed)) continue;
        const msg = parsed;

        if (msg.type === "assistant" && msg.message !== undefined && Array.isArray(msg.message.content)) {
          const content = msg.message.content;
          const fullText = content
            .filter((b) => b.type === "text" && b.text !== undefined)
            .map((b) => b.text!)
            .join("");

          if (fullText.length > lastWrittenLength) {
            const delta = fullText.slice(lastWrittenLength);
            await appendFile(logPath, delta);
            lastWrittenLength = fullText.length;
          }

          for (const block of content) {
            if (block.type === "tool_use" && block.id !== undefined && !seenToolUseIds.has(block.id)) {
              seenToolUseIds.add(block.id);
              await appendFile(logPath, `\n[tool_use] ${block.name ?? "unknown"} ${JSON.stringify(block.input)}\n`);
            }
          }
        } else if (msg.type === "tool_result") {
          const status = msg.is_error === true ? "error" : "success";
          await appendFile(logPath, `[tool_result] → ${status}\n`);
        } else {
          const result = parseResultFromMsg(msg);
          if (result !== undefined) claudeResult = result;
        }
      } catch {
        // skip unparseable lines
      }
    }
  }

  // Process remaining buffer
  if (buffer.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(buffer);
      if (isStreamMessage(parsed)) {
        const result = parseResultFromMsg(parsed);
        if (result !== undefined) claudeResult = result;
      }
    } catch {
      // skip
    }
  }

  // Fallback: if no partial messages were written, use result.result
  if (lastWrittenLength === 0 && claudeResult !== undefined && claudeResult.result !== "") {
    await Bun.write(logPath, claudeResult.result);
  }

  const exitCode = await proc.exited;
  return { exitCode, result: claudeResult };
}
