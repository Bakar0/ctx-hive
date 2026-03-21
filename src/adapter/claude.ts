import { appendFile } from "node:fs/promises";
import { ensureLogsDir, buildLogPath } from "../utils/logs.ts";

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

export async function spawnClaude(options: SpawnClaudeOptions): Promise<ClaudeInstance> {
  if (!Bun.which("claude")) {
    throw new Error("'claude' CLI not found in PATH. Install it first.");
  }

  const logsDir = options.logsDir ?? "logs";
  await ensureLogsDir(logsDir);
  const logPath = buildLogPath(options.name, logsDir);

  const env = { ...process.env };
  // Prevent recursive Claude Code invocations when spawned from within Claude Code
  delete env.CLAUDECODE;

  const args = ["claude", "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.allowedTools && options.allowedTools.length > 0) {
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

async function processStream(
  proc: ReturnType<typeof Bun.spawn>,
  logPath: string,
): Promise<{ exitCode: number; result?: ClaudeResult }> {
  let claudeResult: ClaudeResult | undefined;
  let lastWrittenLength = 0;
  const seenToolUseIds = new Set<string>();

  // Create the log file immediately so tail -f can attach
  await Bun.write(logPath, "");

  const stdout = proc.stdout as ReadableStream<Uint8Array>;
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);

        if (msg.type === "assistant" && msg.message?.content) {
          const fullText = msg.message.content
            .filter((b: { type: string }) => b.type === "text")
            .map((b: { text: string }) => b.text)
            .join("");

          if (fullText.length > lastWrittenLength) {
            const delta = fullText.slice(lastWrittenLength);
            await appendFile(logPath, delta);
            lastWrittenLength = fullText.length;
          }

          for (const block of msg.message.content) {
            if (block.type === "tool_use" && !seenToolUseIds.has(block.id)) {
              seenToolUseIds.add(block.id);
              await appendFile(logPath, `\n[tool_use] ${block.name} ${JSON.stringify(block.input)}\n`);
            }
          }
        } else if (msg.type === "tool_result") {
          const status = msg.is_error ? "error" : "success";
          await appendFile(logPath, `[tool_result] → ${status}\n`);
        } else if (msg.type === "result") {
          claudeResult = {
            result: msg.result,
            duration_ms: msg.duration_ms,
            duration_api_ms: msg.duration_api_ms,
            total_cost_usd: msg.total_cost_usd,
            usage: {
              input_tokens: msg.usage.input_tokens,
              output_tokens: msg.usage.output_tokens,
              cache_creation_input_tokens: msg.usage.cache_creation_input_tokens,
              cache_read_input_tokens: msg.usage.cache_read_input_tokens,
            },
          };
        }
      } catch {
        // skip unparseable lines
      }
    }
  }

  // Process remaining buffer
  if (buffer.trim()) {
    try {
      const msg = JSON.parse(buffer);
      if (msg.type === "result") {
        claudeResult = {
          result: msg.result,
          duration_ms: msg.duration_ms,
          duration_api_ms: msg.duration_api_ms,
          total_cost_usd: msg.total_cost_usd,
          usage: {
            input_tokens: msg.usage.input_tokens,
            output_tokens: msg.usage.output_tokens,
            cache_creation_input_tokens: msg.usage.cache_creation_input_tokens,
            cache_read_input_tokens: msg.usage.cache_read_input_tokens,
          },
        };
      }
    } catch {
      // skip
    }
  }

  // Fallback: if no partial messages were written, use result.result
  if (lastWrittenLength === 0 && claudeResult?.result) {
    await Bun.write(logPath, claudeResult.result);
  }

  const exitCode = await proc.exited;
  return { exitCode, result: claudeResult };
}
