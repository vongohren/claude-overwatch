// In-memory session store for Claude Overwatch
// With SQLite persistence for durability

import { broadcaster } from "./broadcaster.js";
import { db } from "./db.js";
import type {
  PendingState,
  Session,
  SessionResponse,
  SessionStatus,
} from "./types.js";

// Status thresholds in milliseconds
const ACTIVE_THRESHOLD = 30 * 1000; // 30 seconds
const IDLE_THRESHOLD = 5 * 60 * 1000; // 5 minutes

// Known Claude Code tools for extraction from permission messages
const KNOWN_TOOLS = [
  "Bash",
  "WebFetch",
  "WebSearch",
  "Read",
  "Write",
  "Edit",
  "Grep",
  "Glob",
  "Task",
  "NotebookEdit",
  "TodoWrite",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "Skill",
  "KillShell",
  "TaskOutput",
];

// Extract tool name from permission message
function extractToolFromMessage(message: string): string {
  // Try to match patterns like "Allow Bash to...", "Tool: Bash", etc.
  for (const tool of KNOWN_TOOLS) {
    const patterns = [
      new RegExp(`\\b${tool}\\b`, "i"),
      new RegExp(`tool[:\\s]+${tool}`, "i"),
      new RegExp(`allow\\s+${tool}`, "i"),
    ];
    for (const pattern of patterns) {
      if (pattern.test(message)) {
        return tool;
      }
    }
  }
  return "unknown";
}

// Extract tool input/parameters from permission message
function extractToolInputFromMessage(message: string): string {
  // Try to extract quoted strings or command content
  const quotedMatch = message.match(/"([^"]+)"|'([^']+)'|`([^`]+)`/);
  if (quotedMatch) {
    return quotedMatch[1] || quotedMatch[2] || quotedMatch[3] || "";
  }
  return "";
}

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

    // Don't automatically clear pending state for stale sessions.
    // A session can legitimately be waiting for user input for hours.
    // Pending state is only cleared by explicit events:
    // - Tool activity (user approved/responded)
    // - Session end
    // - New notification replacing the old one

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
      pendingState: null,
      pendingMessage: "",
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
      // If there was a pending permission request, resolve it as approved
      if (session.pendingState === "permission_prompt") {
        db.resolvePermissionRequest(id, "approved");
      }

      session.lastActivity = new Date();
      session.lastTool = toolName;
      session.lastToolInput = toolInput;
      session.status = this.calculateStatus(session);
      // Tool activity means approval was granted, clear pending state
      session.pendingState = null;
      session.pendingMessage = "";

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

  setPendingState(
    id: string,
    pendingState: PendingState,
    pendingMessage: string,
  ): Session | undefined {
    this.ensureInitialized();

    const session = this.sessions.get(id);
    if (session) {
      session.pendingState = pendingState;
      session.pendingMessage = pendingMessage;
      session.lastActivity = new Date();

      // Persist to database
      db.updatePendingState(id, pendingState, pendingMessage);

      // Log permission request for analytics
      if (pendingState === "permission_prompt") {
        const toolName = extractToolFromMessage(pendingMessage);
        const toolInput = extractToolInputFromMessage(pendingMessage);
        db.logPermissionRequest(
          id,
          session.projectPath,
          session.projectName,
          toolName,
          toolInput,
          pendingMessage,
        );
      }

      // Broadcast update
      broadcaster.broadcastSessionUpdate(this.toResponse(session));
    }
    return session;
  }

  clearPendingState(id: string): Session | undefined {
    return this.setPendingState(id, null, "");
  }

  endSession(id: string): Session | undefined {
    this.ensureInitialized();

    const session = this.sessions.get(id);
    if (session) {
      // If there was a pending permission request, resolve it as timeout
      if (session.pendingState === "permission_prompt") {
        db.resolvePermissionRequest(id, "timeout");
      }

      // Clear any pending state
      session.pendingState = null;
      session.pendingMessage = "";
      session.status = "ended";
      session.lastActivity = new Date();

      // Persist to database (endSession also clears pending state)
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

  // Permission request analytics
  getPermissionRequests(limit = 100) {
    return db.getPermissionRequests(limit);
  }

  getPermissionRequestsByTool(toolName: string, limit = 100) {
    return db.getPermissionRequestsByTool(toolName, limit);
  }

  getPermissionRequestsByProject(projectName: string, limit = 100) {
    return db.getPermissionRequestsByProject(projectName, limit);
  }

  getPermissionAnalytics() {
    return db.getPermissionAnalytics();
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
      pendingState: session.pendingState,
      pendingMessage: session.pendingMessage,
    };
  }
}

export const store = new SessionStore();
