// In-memory session store for Claude Overwatch
// With SQLite persistence for durability

import { broadcaster } from "./broadcaster.js";
import { db } from "./db.js";
import type { Session, SessionResponse, SessionStatus } from "./types.js";

// Status thresholds in milliseconds
const ACTIVE_THRESHOLD = 30 * 1000; // 30 seconds
const IDLE_THRESHOLD = 5 * 60 * 1000; // 5 minutes

export class SessionStore {
  private sessions: Map<string, Session> = new Map();
  private initialized = false;

  // Load sessions from database on first access
  private ensureInitialized(): void {
    if (this.initialized) return;

    const dbSessions = db.getAllSessions();
    for (const session of dbSessions) {
      this.sessions.set(session.id, session);
    }
    this.initialized = true;
  }

  private calculateStatus(session: Session): SessionStatus {
    if (session.status === "ended") {
      return "ended";
    }

    const now = Date.now();
    const elapsed = now - session.lastActivity.getTime();

    if (elapsed < ACTIVE_THRESHOLD) {
      return "active";
    }
    if (elapsed < IDLE_THRESHOLD) {
      return "idle";
    }
    return "stale";
  }

  createSession(
    id: string,
    projectPath: string,
    transcriptPath: string,
  ): Session {
    this.ensureInitialized();

    const projectName = projectPath.split("/").pop() || projectPath;
    const now = new Date();

    const session: Session = {
      id,
      projectPath,
      projectName,
      status: "active",
      lastActivity: now,
      lastTool: "",
      lastToolInput: "",
      startedAt: now,
      transcriptPath,
    };

    this.sessions.set(id, session);

    // Persist to database
    db.upsertSession(session);
    db.logEvent(id, "session-start", null, null);

    // Broadcast update
    broadcaster.broadcastSessionUpdate(this.toResponse(session));

    return session;
  }

  getSession(id: string): Session | undefined {
    this.ensureInitialized();

    const session = this.sessions.get(id);
    if (session) {
      session.status = this.calculateStatus(session);
    }
    return session;
  }

  getAllSessions(): Session[] {
    this.ensureInitialized();

    const sessions = Array.from(this.sessions.values());
    for (const session of sessions) {
      session.status = this.calculateStatus(session);
    }
    return sessions.sort(
      (a, b) => b.lastActivity.getTime() - a.lastActivity.getTime(),
    );
  }

  updateActivity(
    id: string,
    toolName: string,
    toolInput: string,
  ): Session | undefined {
    this.ensureInitialized();

    const session = this.sessions.get(id);
    if (session) {
      session.lastActivity = new Date();
      session.lastTool = toolName;
      session.lastToolInput = toolInput;
      session.status = this.calculateStatus(session);

      // Persist to database
      db.updateSessionActivity(
        id,
        session.lastActivity,
        toolName,
        toolInput,
        session.status,
      );
      db.logEvent(id, "tool-use", toolName, toolInput);

      // Broadcast update
      broadcaster.broadcastSessionUpdate(this.toResponse(session));
    }
    return session;
  }

  endSession(id: string): Session | undefined {
    this.ensureInitialized();

    const session = this.sessions.get(id);
    if (session) {
      session.status = "ended";
      session.lastActivity = new Date();

      // Persist to database
      db.endSession(id);
      db.logEvent(id, "session-end", null, null);

      // Broadcast session ended
      broadcaster.broadcastSessionEnded(id);
    }
    return session;
  }

  // Import a session discovered by the scanner (doesn't overwrite existing)
  importSession(session: Session): boolean {
    this.ensureInitialized();

    if (this.sessions.has(session.id)) {
      return false; // Already exists
    }
    this.sessions.set(session.id, session);

    // Persist to database
    db.upsertSession(session);

    return true;
  }

  // Check if session exists
  hasSession(id: string): boolean {
    this.ensureInitialized();
    return this.sessions.has(id);
  }

  // Log file access for a session
  logFileAccess(
    sessionId: string,
    filePath: string,
    accessType: "read" | "write" | "edit",
  ): void {
    db.logFileAccess(sessionId, filePath, accessType);
  }

  // Get files accessed by a session
  getSessionFiles(sessionId: string) {
    return db.getSessionFiles(sessionId);
  }

  // Get session event history
  getSessionEvents(sessionId: string, limit = 100) {
    return db.getSessionEvents(sessionId, limit);
  }

  toResponse(session: Session): SessionResponse {
    return {
      id: session.id,
      projectPath: session.projectPath,
      projectName: session.projectName,
      status: this.calculateStatus(session),
      lastActivity: session.lastActivity.toISOString(),
      lastTool: session.lastTool,
      lastToolInput: session.lastToolInput,
      startedAt: session.startedAt.toISOString(),
      transcriptPath: session.transcriptPath,
    };
  }
}

export const store = new SessionStore();
