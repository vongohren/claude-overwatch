// WebSocket broadcaster for real-time session updates
// Manages connected clients and broadcasts updates

import type { WebSocket } from "ws";
import type { ClientMessage, ServerMessage, SessionResponse } from "./types.js";

const HEARTBEAT_INTERVAL = 30 * 1000; // 30 seconds

export class Broadcaster {
  private clients: Set<WebSocket> = new Set();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private getSessionsFn: (() => SessionResponse[]) | null = null;

  // Set the function to get all sessions (injected to avoid circular deps)
  setGetSessionsFn(fn: () => SessionResponse[]): void {
    this.getSessionsFn = fn;
  }

  // Add a new client connection
  addClient(ws: WebSocket): void {
    this.clients.add(ws);

    // Send initial session list
    if (this.getSessionsFn) {
      const sessions = this.getSessionsFn();
      this.send(ws, { type: "sessions", data: sessions });
    }

    // Handle incoming messages
    ws.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as ClientMessage;
        this.handleMessage(ws, message);
      } catch {
        // Ignore malformed messages
      }
    });

    // Handle client disconnect
    ws.on("close", () => {
      this.clients.delete(ws);
    });

    ws.on("error", () => {
      this.clients.delete(ws);
    });
  }

  // Handle incoming client messages
  private handleMessage(ws: WebSocket, message: ClientMessage): void {
    switch (message.type) {
      case "subscribe":
        // Client is already subscribed on connect, this is a no-op
        break;

      case "get-sessions":
        if (this.getSessionsFn) {
          const sessions = this.getSessionsFn();
          this.send(ws, { type: "sessions", data: sessions });
        }
        break;
    }
  }

  // Send a message to a specific client
  private send(ws: WebSocket, message: ServerMessage): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  // Broadcast a message to all connected clients
  broadcast(message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    }
  }

  // Broadcast a session update
  broadcastSessionUpdate(session: SessionResponse): void {
    this.broadcast({ type: "session-update", data: session });
  }

  // Broadcast a session ended event
  broadcastSessionEnded(id: string): void {
    this.broadcast({ type: "session-ended", id });
  }

  // Start heartbeat to keep connections alive
  startHeartbeat(): void {
    if (this.heartbeatInterval) {
      return; // Already running
    }

    this.heartbeatInterval = setInterval(() => {
      this.broadcast({ type: "heartbeat" });
    }, HEARTBEAT_INTERVAL);
  }

  // Stop heartbeat
  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  // Get number of connected clients
  getClientCount(): number {
    return this.clients.size;
  }

  // Close all connections
  close(): void {
    this.stopHeartbeat();
    for (const ws of this.clients) {
      ws.close();
    }
    this.clients.clear();
  }
}

export const broadcaster = new Broadcaster();
