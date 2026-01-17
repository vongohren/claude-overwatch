// Claude Overwatch Dashboard
// Real-time monitoring of Claude Code sessions

import type { ServerMessage, SessionResponse, SessionStatus } from "./types";
import { renderFilterBar, renderHeader, renderSessionList } from "./ui";
import { OverwatchWebSocket, fetchSessions } from "./websocket";
import "./styles.css";

function getElement(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Element with id "${id}" not found`);
  }
  return el;
}

class Dashboard {
  private sessions: Map<string, SessionResponse> = new Map();
  private ws: OverwatchWebSocket;
  private connected = false;
  private filter: SessionStatus | "all" = "all";
  private searchQuery = "";
  private updateInterval: ReturnType<typeof setInterval> | null = null;

  private app: HTMLElement;
  private header: HTMLElement;
  private filterBar: HTMLElement;
  private sessionList: HTMLElement;

  constructor() {
    this.app = getElement("app");
    this.setupLayout();

    this.header = getElement("header");
    this.filterBar = getElement("filter-bar");
    this.sessionList = getElement("session-list");

    this.ws = new OverwatchWebSocket(
      this.handleMessage.bind(this),
      this.handleConnectionChange.bind(this),
    );

    this.bindEvents();
    this.render();
  }

  private setupLayout(): void {
    this.app.innerHTML = `
      <header id="header"></header>
      <div id="filter-bar" class="filter-bar"></div>
      <main id="session-list" class="session-list"></main>
    `;
  }

  private bindEvents(): void {
    // Filter change
    this.filterBar.addEventListener("change", (e) => {
      const target = e.target as HTMLSelectElement;
      if (target.id === "status-filter") {
        this.filter = target.value as SessionStatus | "all";
        this.renderSessionList();
      }
    });

    // Search input
    this.filterBar.addEventListener("input", (e) => {
      const target = e.target as HTMLInputElement;
      if (target.id === "search-input") {
        this.searchQuery = target.value.toLowerCase();
        this.renderSessionList();
      }
    });

    // Refresh button
    this.header.addEventListener("click", async (e) => {
      const target = e.target as HTMLElement;
      if (target.classList.contains("refresh-btn")) {
        await this.refreshSessions();
      }
    });
  }

  start(): void {
    this.ws.connect();

    // Update relative times every 5 seconds
    this.updateInterval = setInterval(() => {
      this.renderSessionList();
    }, 5000);
  }

  stop(): void {
    this.ws.disconnect();
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
  }

  private handleMessage(message: ServerMessage): void {
    switch (message.type) {
      case "sessions":
        this.sessions.clear();
        for (const session of message.data) {
          this.sessions.set(session.id, session);
        }
        this.render();
        break;

      case "session-update":
        this.sessions.set(message.data.id, message.data);
        this.render();
        break;

      case "session-ended": {
        const existingSession = this.sessions.get(message.id);
        if (existingSession) {
          existingSession.status = "ended";
          this.sessions.set(message.id, existingSession);
        }
        this.render();
        break;
      }

      case "heartbeat":
        // Keep-alive, no action needed
        break;
    }
  }

  private handleConnectionChange(connected: boolean): void {
    this.connected = connected;
    this.renderHeader();

    // If reconnected, fetch current sessions
    if (connected && this.sessions.size === 0) {
      this.refreshSessions();
    }
  }

  private async refreshSessions(): Promise<void> {
    try {
      const sessions = await fetchSessions();
      this.sessions.clear();
      for (const session of sessions) {
        this.sessions.set(session.id, session);
      }
      this.render();
    } catch (error) {
      console.error("Failed to refresh sessions:", error);
    }
  }

  private getFilteredSessions(): SessionResponse[] {
    let sessions = Array.from(this.sessions.values());

    // Filter by status
    if (this.filter !== "all") {
      sessions = sessions.filter((s) => s.status === this.filter);
    }

    // Filter by search query
    if (this.searchQuery) {
      sessions = sessions.filter(
        (s) =>
          s.projectName.toLowerCase().includes(this.searchQuery) ||
          s.projectPath.toLowerCase().includes(this.searchQuery) ||
          s.lastTool.toLowerCase().includes(this.searchQuery),
      );
    }

    return sessions;
  }

  private render(): void {
    this.renderHeader();
    this.renderFilterBar();
    this.renderSessionList();
  }

  private renderHeader(): void {
    this.header.innerHTML = renderHeader(this.connected, this.sessions.size);
  }

  private renderFilterBar(): void {
    this.filterBar.innerHTML = renderFilterBar(this.filter, this.searchQuery);
  }

  private renderSessionList(): void {
    const filtered = this.getFilteredSessions();
    this.sessionList.innerHTML = renderSessionList(filtered);
  }
}

// Start the dashboard
const dashboard = new Dashboard();
dashboard.start();

// Cleanup on page unload
window.addEventListener("beforeunload", () => {
  dashboard.stop();
});
