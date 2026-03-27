/**
 * WebSocket broadcaster for live dashboard updates.
 * Clients connect and receive periodic metric snapshots + event pushes.
 */
import type { ServerWebSocket } from "bun";
import { getMetrics, type MetricsSnapshot } from "./api.ts";

// ── Client tracking ───────────────────────────────────────────────────

const clients = new Set<ServerWebSocket<unknown>>();

export function addClient(ws: ServerWebSocket<unknown>): void {
  clients.add(ws);
}

export function removeClient(ws: ServerWebSocket<unknown>): void {
  clients.delete(ws);
}

export function clientCount(): number {
  return clients.size;
}

// ── Broadcasting ──────────────────────────────────────────────────────

function broadcast(event: string, data: unknown): void {
  const message = JSON.stringify({ event, data });
  for (const ws of clients) {
    try {
      ws.send(message);
    } catch {
      clients.delete(ws);
    }
  }
}

export function broadcastMetrics(metrics: MetricsSnapshot): void {
  broadcast("metrics", metrics);
}

export function broadcastJobEvent(
  type: "job:started" | "job:completed" | "job:failed" | "job:queued",
  job: unknown
): void {
  metricsDirty = true;
  broadcast(type, job);
}

export function broadcastMemoryEvent(
  type: "memory:created" | "memory:deleted",
  data: unknown
): void {
  metricsDirty = true;
  broadcast(type, data);
}

export function broadcastRepoEvent(
  type: "repo:tracked" | "repo:untracked" | "repo:scan-complete",
  data: unknown
): void {
  metricsDirty = true;
  broadcast(type, data);
}

export function broadcastPipelineEvent(
  type: "pipeline:started" | "pipeline:stage-changed" | "pipeline:completed" | "pipeline:failed",
  data: unknown,
): void {
  metricsDirty = true;
  broadcast(type, data);
}

export function broadcastSearchEvent(data: unknown): void {
  broadcast("search:executed", data);
}

// ── Periodic metrics push (dirty-flag gated) ──────────────────────────

let metricsInterval: ReturnType<typeof setInterval> | null = null;
let metricsDirty = true; // start dirty so first broadcast sends data

export function markMetricsDirty(): void {
  metricsDirty = true;
}

export function startMetricsBroadcast(intervalMs = 5_000): void {
  if (metricsInterval) return;
  metricsInterval = setInterval(() => {
    if (clients.size === 0 || !metricsDirty) return;
    metricsDirty = false;
    void (async () => {
      try {
        const metrics = await getMetrics();
        broadcastMetrics(metrics);
      } catch {
        // ignore transient errors
      }
    })();
  }, intervalMs);
}

export function stopMetricsBroadcast(): void {
  if (metricsInterval) {
    clearInterval(metricsInterval);
    metricsInterval = null;
  }
}

// ── WebSocket handlers (for Bun.serve websocket config) ───────────────

export const wsHandlers = {
  open(ws: ServerWebSocket<unknown>) {
    addClient(ws);
    // Send initial metrics immediately
    getMetrics()
      .then((m) => ws.send(JSON.stringify({ event: "metrics", data: m })))
      .catch(() => {});
  },
  close(ws: ServerWebSocket<unknown>) {
    removeClient(ws);
  },
  message(_ws: ServerWebSocket<unknown>, _message: string | Buffer) {
    // No client→server messages expected, but could handle ping/pong here
  },
};
