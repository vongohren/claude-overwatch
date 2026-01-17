// WebSocket client with auto-reconnect

import type { ServerMessage, SessionResponse } from "./types";

export type MessageHandler = (message: ServerMessage) => void;
export type ConnectionHandler = (connected: boolean) => void;

export class OverwatchWebSocket {
  private ws: WebSocket | null = null;
  private url: string;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private reconnectAttempts = 0;
  private onMessage: MessageHandler;
  private onConnectionChange: ConnectionHandler;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;

  constructor(
    onMessage: MessageHandler,
    onConnectionChange: ConnectionHandler,
  ) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.url = `${protocol}//${window.location.host}/ws`;
    this.onMessage = onMessage;
    this.onConnectionChange = onConnectionChange;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    this.shouldReconnect = true;

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        console.log("WebSocket connected");
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1000;
        this.onConnectionChange(true);
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as ServerMessage;
          this.onMessage(message);
        } catch (error) {
          console.error("Failed to parse message:", error);
        }
      };

      this.ws.onclose = () => {
        console.log("WebSocket disconnected");
        this.onConnectionChange(false);
        this.scheduleReconnect();
      };

      this.ws.onerror = (error) => {
        console.error("WebSocket error:", error);
      };
    } catch (error) {
      console.error("Failed to create WebSocket:", error);
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) {
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      this.reconnectDelay * 1.5 ** (this.reconnectAttempts - 1),
      this.maxReconnectDelay,
    );

    console.log(`Reconnecting in ${Math.round(delay / 1000)}s...`);

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  send(message: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }
}

// Fetch sessions via REST API (fallback)
export async function fetchSessions(): Promise<SessionResponse[]> {
  const response = await fetch("/sessions");
  if (!response.ok) {
    throw new Error(`Failed to fetch sessions: ${response.status}`);
  }
  return response.json();
}
