import type { WsEvent } from "../api/types";

type Handler = (data: unknown) => void;

export class DashboardSocket {
  connected = $state(false);
  private ws: WebSocket | null = null;
  private handlers = new Map<WsEvent, Handler[]>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  connect(): void {
    if (this.ws) return;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws`;
    const ws = new WebSocket(url);

    ws.onopen = () => {
      this.connected = true;
    };

    ws.onclose = () => {
      this.connected = false;
      this.ws = null;
      this.scheduleReconnect();
    };

    ws.onerror = () => {
      ws.close();
    };

    ws.onmessage = (e) => {
      try {
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        const raw = JSON.parse(String(e.data)) as { event: WsEvent; data: unknown };
        const handlers = this.handlers.get(raw.event);
        if (handlers != null) {
          for (const h of handlers) h(raw.data);
        }
      } catch {
        // ignore malformed messages
      }
    };

    this.ws = ws;
  }

  on(event: WsEvent, handler: Handler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  off(event: WsEvent, handler: Handler): void {
    const list = this.handlers.get(event);
    if (list == null) return;
    const idx = list.indexOf(handler);
    if (idx >= 0) list.splice(idx, 1);
  }

  disconnect(): void {
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer != null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }
}
