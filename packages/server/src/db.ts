// SQLite database for Claude Overwatch
// Uses bun:sqlite for persistence

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type {
  PendingState,
  PermissionRequest,
  PermissionResolution,
  Session,
  SessionStatus,
} from "./types.js";

const DB_DIR = join(homedir(), ".claude-overwatch");
const DB_PATH = join(DB_DIR, "overwatch.db");

// Schema version for migrations
const SCHEMA_VERSION = 4;

// Initialize database with schema
function initSchema(db: Database): void {
  db.exec(`
    -- Schema versioning
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );

    -- Sessions table
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      project_name TEXT NOT NULL,
      status TEXT NOT NULL,
      last_activity TEXT NOT NULL,
      last_tool TEXT DEFAULT '',
      last_tool_input TEXT DEFAULT '',
      started_at TEXT NOT NULL,
      ended_at TEXT,
      transcript_path TEXT DEFAULT ''
    );

    -- Events table for history
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      tool_name TEXT,
      tool_input TEXT,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    -- File access tracking
    CREATE TABLE IF NOT EXISTS file_access (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      access_type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    -- Permission requests tracking for analytics
    CREATE TABLE IF NOT EXISTS permission_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project_path TEXT NOT NULL,
      project_name TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_input TEXT DEFAULT '',
      message TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      resolved_at TEXT,
      resolution TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    -- Raw events table for debugging - stores full incoming payloads
    CREATE TABLE IF NOT EXISTS raw_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payload TEXT NOT NULL,
      received_at TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      session_id TEXT,
      event_type TEXT
    );

    -- Indexes for performance
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_file_access_path ON file_access(file_path);
    CREATE INDEX IF NOT EXISTS idx_file_access_session ON file_access(session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity);
    CREATE INDEX IF NOT EXISTS idx_permission_requests_session ON permission_requests(session_id);
    CREATE INDEX IF NOT EXISTS idx_permission_requests_tool ON permission_requests(tool_name);
    CREATE INDEX IF NOT EXISTS idx_permission_requests_project ON permission_requests(project_name);
    CREATE INDEX IF NOT EXISTS idx_permission_requests_timestamp ON permission_requests(requested_at);
    CREATE INDEX IF NOT EXISTS idx_raw_events_received_at ON raw_events(received_at);
    CREATE INDEX IF NOT EXISTS idx_raw_events_session_id ON raw_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_raw_events_event_type ON raw_events(event_type);
  `);

  // Set schema version
  const versionRow = db.query("SELECT version FROM schema_version").get();
  if (!versionRow) {
    db.exec(`INSERT INTO schema_version (version) VALUES (${SCHEMA_VERSION})`);
  }
}

// Run migrations if needed
function runMigrations(db: Database): void {
  const versionRow = db.query("SELECT version FROM schema_version").get() as {
    version: number;
  } | null;
  const currentVersion = versionRow?.version || 1;

  if (currentVersion < 2) {
    // Migration 1 -> 2: Add pending state columns
    db.exec(`
      ALTER TABLE sessions ADD COLUMN pending_state TEXT DEFAULT NULL;
      ALTER TABLE sessions ADD COLUMN pending_message TEXT DEFAULT '';
    `);
    db.exec("UPDATE schema_version SET version = 2");
  }

  if (currentVersion < 3) {
    // Migration 2 -> 3: Add permission_requests table for analytics
    db.exec(`
      CREATE TABLE IF NOT EXISTS permission_requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        project_path TEXT NOT NULL,
        project_name TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        tool_input TEXT DEFAULT '',
        message TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        resolved_at TEXT,
        resolution TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_permission_requests_session ON permission_requests(session_id);
      CREATE INDEX IF NOT EXISTS idx_permission_requests_tool ON permission_requests(tool_name);
      CREATE INDEX IF NOT EXISTS idx_permission_requests_project ON permission_requests(project_name);
      CREATE INDEX IF NOT EXISTS idx_permission_requests_timestamp ON permission_requests(requested_at);
    `);
    db.exec("UPDATE schema_version SET version = 3");
  }

  if (currentVersion < 4) {
    // Migration 3 -> 4: Add raw_events table for debugging
    db.exec(`
      CREATE TABLE IF NOT EXISTS raw_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payload TEXT NOT NULL,
        received_at TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        session_id TEXT,
        event_type TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_raw_events_received_at ON raw_events(received_at);
      CREATE INDEX IF NOT EXISTS idx_raw_events_session_id ON raw_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_raw_events_event_type ON raw_events(event_type);
    `);
    db.exec("UPDATE schema_version SET version = 4");
  }
}

export class OverwatchDB {
  private db: Database;

  constructor(dbPath: string = DB_PATH) {
    // Ensure directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");

    initSchema(this.db);
    runMigrations(this.db);
  }

  // Session CRUD operations

  upsertSession(session: Session): void {
    const stmt = this.db.prepare(`
      INSERT INTO sessions (
        id, project_path, project_name, status, last_activity,
        last_tool, last_tool_input, started_at, transcript_path,
        pending_state, pending_message
      ) VALUES (
        $id, $projectPath, $projectName, $status, $lastActivity,
        $lastTool, $lastToolInput, $startedAt, $transcriptPath,
        $pendingState, $pendingMessage
      )
      ON CONFLICT(id) DO UPDATE SET
        status = $status,
        last_activity = $lastActivity,
        last_tool = $lastTool,
        last_tool_input = $lastToolInput,
        pending_state = $pendingState,
        pending_message = $pendingMessage
    `);

    stmt.run({
      $id: session.id,
      $projectPath: session.projectPath,
      $projectName: session.projectName,
      $status: session.status,
      $lastActivity: session.lastActivity.toISOString(),
      $lastTool: session.lastTool,
      $lastToolInput: session.lastToolInput,
      $startedAt: session.startedAt.toISOString(),
      $transcriptPath: session.transcriptPath,
      $pendingState: session.pendingState,
      $pendingMessage: session.pendingMessage,
    });
  }

  getSession(id: string): Session | null {
    const row = this.db
      .query(
        `
      SELECT id, project_path, project_name, status, last_activity,
             last_tool, last_tool_input, started_at, transcript_path,
             pending_state, pending_message
      FROM sessions WHERE id = $id
    `,
      )
      .get({ $id: id }) as SessionRow | null;

    return row ? this.rowToSession(row) : null;
  }

  getAllSessions(): Session[] {
    const rows = this.db
      .query(
        `
      SELECT id, project_path, project_name, status, last_activity,
             last_tool, last_tool_input, started_at, transcript_path,
             pending_state, pending_message
      FROM sessions
      ORDER BY last_activity DESC
    `,
      )
      .all() as SessionRow[];

    return rows.map((row) => this.rowToSession(row));
  }

  getActiveSessions(): Session[] {
    const rows = this.db
      .query(
        `
      SELECT id, project_path, project_name, status, last_activity,
             last_tool, last_tool_input, started_at, transcript_path,
             pending_state, pending_message
      FROM sessions
      WHERE status != 'ended'
      ORDER BY last_activity DESC
    `,
      )
      .all() as SessionRow[];

    return rows.map((row) => this.rowToSession(row));
  }

  endSession(id: string): void {
    this.db
      .prepare(
        `
      UPDATE sessions
      SET status = 'ended', ended_at = $endedAt,
          pending_state = NULL, pending_message = ''
      WHERE id = $id
    `,
      )
      .run({
        $id: id,
        $endedAt: new Date().toISOString(),
      });
  }

  updateSessionActivity(
    id: string,
    lastActivity: Date,
    lastTool: string,
    lastToolInput: string,
    status: SessionStatus,
  ): void {
    this.db
      .prepare(
        `
      UPDATE sessions
      SET last_activity = $lastActivity,
          last_tool = $lastTool,
          last_tool_input = $lastToolInput,
          status = $status,
          pending_state = NULL,
          pending_message = ''
      WHERE id = $id
    `,
      )
      .run({
        $id: id,
        $lastActivity: lastActivity.toISOString(),
        $lastTool: lastTool,
        $lastToolInput: lastToolInput,
        $status: status,
      });
  }

  updatePendingState(
    id: string,
    pendingState: PendingState,
    pendingMessage: string,
  ): void {
    this.db
      .prepare(
        `
      UPDATE sessions
      SET pending_state = $pendingState,
          pending_message = $pendingMessage,
          last_activity = $lastActivity
      WHERE id = $id
    `,
      )
      .run({
        $id: id,
        $pendingState: pendingState,
        $pendingMessage: pendingMessage,
        $lastActivity: new Date().toISOString(),
      });
  }

  // Event logging

  logEvent(
    sessionId: string,
    eventType: string,
    toolName: string | null,
    toolInput: string | null,
  ): void {
    this.db
      .prepare(
        `
      INSERT INTO events (session_id, event_type, tool_name, tool_input, timestamp)
      VALUES ($sessionId, $eventType, $toolName, $toolInput, $timestamp)
    `,
      )
      .run({
        $sessionId: sessionId,
        $eventType: eventType,
        $toolName: toolName,
        $toolInput: toolInput,
        $timestamp: new Date().toISOString(),
      });
  }

  getSessionEvents(sessionId: string, limit = 100): EventRecord[] {
    return this.db
      .query(
        `
      SELECT id, session_id, event_type, tool_name, tool_input, timestamp
      FROM events
      WHERE session_id = $sessionId
      ORDER BY timestamp DESC
      LIMIT $limit
    `,
      )
      .all({ $sessionId: sessionId, $limit: limit }) as EventRecord[];
  }

  // File access tracking

  logFileAccess(
    sessionId: string,
    filePath: string,
    accessType: "read" | "write" | "edit",
  ): void {
    this.db
      .prepare(
        `
      INSERT INTO file_access (session_id, file_path, access_type, timestamp)
      VALUES ($sessionId, $filePath, $accessType, $timestamp)
    `,
      )
      .run({
        $sessionId: sessionId,
        $filePath: filePath,
        $accessType: accessType,
        $timestamp: new Date().toISOString(),
      });
  }

  getSessionFiles(sessionId: string): FileAccessRecord[] {
    return this.db
      .query(
        `
      SELECT DISTINCT file_path, access_type,
             MAX(timestamp) as last_access
      FROM file_access
      WHERE session_id = $sessionId
      GROUP BY file_path
      ORDER BY last_access DESC
    `,
      )
      .all({ $sessionId: sessionId }) as FileAccessRecord[];
  }

  getFileHistory(filePath: string): FileAccessRecord[] {
    return this.db
      .query(
        `
      SELECT session_id, file_path, access_type, timestamp
      FROM file_access
      WHERE file_path = $filePath
      ORDER BY timestamp DESC
    `,
      )
      .all({ $filePath: filePath }) as FileAccessRecord[];
  }

  // Cleanup old data

  cleanupOldEvents(daysToKeep = 30): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysToKeep);

    const result = this.db
      .prepare(
        `
      DELETE FROM events
      WHERE timestamp < $cutoff
    `,
      )
      .run({ $cutoff: cutoff.toISOString() });

    return result.changes;
  }

  cleanupOldFileAccess(daysToKeep = 30): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysToKeep);

    const result = this.db
      .prepare(
        `
      DELETE FROM file_access
      WHERE timestamp < $cutoff
    `,
      )
      .run({ $cutoff: cutoff.toISOString() });

    return result.changes;
  }

  // Permission request tracking

  logPermissionRequest(
    sessionId: string,
    projectPath: string,
    projectName: string,
    toolName: string,
    toolInput: string,
    message: string,
  ): number {
    const stmt = this.db.prepare(`
      INSERT INTO permission_requests (
        session_id, project_path, project_name, tool_name, tool_input,
        message, requested_at
      ) VALUES (
        $sessionId, $projectPath, $projectName, $toolName, $toolInput,
        $message, $requestedAt
      )
    `);

    const result = stmt.run({
      $sessionId: sessionId,
      $projectPath: projectPath,
      $projectName: projectName,
      $toolName: toolName,
      $toolInput: toolInput,
      $message: message,
      $requestedAt: new Date().toISOString(),
    });

    return Number(result.lastInsertRowid);
  }

  resolvePermissionRequest(
    sessionId: string,
    resolution: PermissionResolution,
  ): void {
    // Resolve the most recent unresolved permission request for this session
    this.db
      .prepare(
        `
      UPDATE permission_requests
      SET resolved_at = $resolvedAt, resolution = $resolution
      WHERE session_id = $sessionId AND resolution IS NULL
      ORDER BY requested_at DESC
      LIMIT 1
    `,
      )
      .run({
        $sessionId: sessionId,
        $resolvedAt: new Date().toISOString(),
        $resolution: resolution,
      });
  }

  getPendingPermissionRequest(sessionId: string): PermissionRequest | null {
    const row = this.db
      .query(
        `
      SELECT id, session_id, project_path, project_name, tool_name, tool_input,
             message, requested_at, resolved_at, resolution
      FROM permission_requests
      WHERE session_id = $sessionId AND resolution IS NULL
      ORDER BY requested_at DESC
      LIMIT 1
    `,
      )
      .get({ $sessionId: sessionId }) as PermissionRequestRow | null;

    return row ? this.rowToPermissionRequest(row) : null;
  }

  getPermissionRequests(limit = 100): PermissionRequest[] {
    const rows = this.db
      .query(
        `
      SELECT id, session_id, project_path, project_name, tool_name, tool_input,
             message, requested_at, resolved_at, resolution
      FROM permission_requests
      ORDER BY requested_at DESC
      LIMIT $limit
    `,
      )
      .all({ $limit: limit }) as PermissionRequestRow[];

    return rows.map((row) => this.rowToPermissionRequest(row));
  }

  getPermissionRequestsByTool(
    toolName: string,
    limit = 100,
  ): PermissionRequest[] {
    const rows = this.db
      .query(
        `
      SELECT id, session_id, project_path, project_name, tool_name, tool_input,
             message, requested_at, resolved_at, resolution
      FROM permission_requests
      WHERE tool_name = $toolName
      ORDER BY requested_at DESC
      LIMIT $limit
    `,
      )
      .all({ $toolName: toolName, $limit: limit }) as PermissionRequestRow[];

    return rows.map((row) => this.rowToPermissionRequest(row));
  }

  getPermissionRequestsByProject(
    projectName: string,
    limit = 100,
  ): PermissionRequest[] {
    const rows = this.db
      .query(
        `
      SELECT id, session_id, project_path, project_name, tool_name, tool_input,
             message, requested_at, resolved_at, resolution
      FROM permission_requests
      WHERE project_name = $projectName
      ORDER BY requested_at DESC
      LIMIT $limit
    `,
      )
      .all({
        $projectName: projectName,
        $limit: limit,
      }) as PermissionRequestRow[];

    return rows.map((row) => this.rowToPermissionRequest(row));
  }

  getPermissionAnalytics(): {
    totalRequests: number;
    byTool: Record<string, number>;
    byProject: Record<string, number>;
    byResolution: Record<string, number>;
  } {
    const totalRow = this.db
      .query("SELECT COUNT(*) as count FROM permission_requests")
      .get() as { count: number };

    const toolRows = this.db
      .query(
        `
      SELECT tool_name, COUNT(*) as count
      FROM permission_requests
      GROUP BY tool_name
      ORDER BY count DESC
    `,
      )
      .all() as { tool_name: string; count: number }[];

    const projectRows = this.db
      .query(
        `
      SELECT project_name, COUNT(*) as count
      FROM permission_requests
      GROUP BY project_name
      ORDER BY count DESC
    `,
      )
      .all() as { project_name: string; count: number }[];

    const resolutionRows = this.db
      .query(
        `
      SELECT COALESCE(resolution, 'pending') as resolution, COUNT(*) as count
      FROM permission_requests
      GROUP BY resolution
    `,
      )
      .all() as { resolution: string; count: number }[];

    return {
      totalRequests: totalRow.count,
      byTool: Object.fromEntries(toolRows.map((r) => [r.tool_name, r.count])),
      byProject: Object.fromEntries(
        projectRows.map((r) => [r.project_name, r.count]),
      ),
      byResolution: Object.fromEntries(
        resolutionRows.map((r) => [r.resolution, r.count]),
      ),
    };
  }

  private rowToPermissionRequest(row: PermissionRequestRow): PermissionRequest {
    return {
      id: row.id,
      sessionId: row.session_id,
      projectPath: row.project_path,
      projectName: row.project_name,
      toolName: row.tool_name,
      toolInput: row.tool_input || "",
      message: row.message,
      requestedAt: new Date(row.requested_at),
      resolvedAt: row.resolved_at ? new Date(row.resolved_at) : null,
      resolution: row.resolution as PermissionResolution,
    };
  }

  // Raw event logging for debugging

  logRawEvent(
    payload: unknown,
    endpoint: string,
    sessionId?: string,
    eventType?: string,
  ): number {
    const stmt = this.db.prepare(`
      INSERT INTO raw_events (payload, received_at, endpoint, session_id, event_type)
      VALUES ($payload, $receivedAt, $endpoint, $sessionId, $eventType)
    `);

    const result = stmt.run({
      $payload: JSON.stringify(payload),
      $receivedAt: new Date().toISOString(),
      $endpoint: endpoint,
      $sessionId: sessionId || null,
      $eventType: eventType || null,
    });

    return Number(result.lastInsertRowid);
  }

  getRawEvents(limit = 100, offset = 0): RawEventRecord[] {
    return this.db
      .query(
        `
      SELECT id, payload, received_at, endpoint, session_id, event_type
      FROM raw_events
      ORDER BY received_at DESC
      LIMIT $limit OFFSET $offset
    `,
      )
      .all({ $limit: limit, $offset: offset }) as RawEventRecord[];
  }

  getRawEventsBySession(sessionId: string, limit = 100): RawEventRecord[] {
    return this.db
      .query(
        `
      SELECT id, payload, received_at, endpoint, session_id, event_type
      FROM raw_events
      WHERE session_id = $sessionId
      ORDER BY received_at DESC
      LIMIT $limit
    `,
      )
      .all({ $sessionId: sessionId, $limit: limit }) as RawEventRecord[];
  }

  getRawEventsByType(eventType: string, limit = 100): RawEventRecord[] {
    return this.db
      .query(
        `
      SELECT id, payload, received_at, endpoint, session_id, event_type
      FROM raw_events
      WHERE event_type = $eventType
      ORDER BY received_at DESC
      LIMIT $limit
    `,
      )
      .all({ $eventType: eventType, $limit: limit }) as RawEventRecord[];
  }

  cleanupOldRawEvents(daysToKeep = 7): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysToKeep);

    const result = this.db
      .prepare(
        `
      DELETE FROM raw_events
      WHERE received_at < $cutoff
    `,
      )
      .run({ $cutoff: cutoff.toISOString() });

    return result.changes;
  }

  // Get the last event for a session to determine if it's waiting for input
  // Returns the notification_type and message if the last event was a notification
  // Returns null if no events or last event was tool activity
  getLastPendingStateForSession(
    sessionId: string,
  ): { pendingState: PendingState; message: string } | null {
    // Get the most recent event for this session
    const lastEvent = this.db
      .query(
        `
      SELECT id, payload, event_type, received_at
      FROM raw_events
      WHERE session_id = $sessionId
      ORDER BY received_at DESC
      LIMIT 1
    `,
      )
      .get({ $sessionId: sessionId }) as RawEventRecord | null;

    if (!lastEvent) {
      return null;
    }

    // If last event was not a notification, session is not waiting
    if (lastEvent.event_type !== "notification") {
      return null;
    }

    // Parse the payload to get notification details
    try {
      const payload = JSON.parse(lastEvent.payload) as {
        notification_type?: string;
        message?: string;
      };

      const notificationType = payload.notification_type;
      if (
        notificationType === "permission_prompt" ||
        notificationType === "idle_prompt" ||
        notificationType === "elicitation_dialog"
      ) {
        return {
          pendingState: notificationType as PendingState,
          message: payload.message || "",
        };
      }
    } catch {
      // Ignore parse errors
    }

    return null;
  }

  // Utility

  private rowToSession(row: SessionRow): Session {
    return {
      id: row.id,
      projectPath: row.project_path,
      projectName: row.project_name,
      status: row.status as SessionStatus,
      lastActivity: new Date(row.last_activity),
      lastTool: row.last_tool || "",
      lastToolInput: row.last_tool_input || "",
      startedAt: new Date(row.started_at),
      transcriptPath: row.transcript_path || "",
      pendingState: row.pending_state as PendingState,
      pendingMessage: row.pending_message || "",
    };
  }

  close(): void {
    this.db.close();
  }
}

// Types for database rows
interface SessionRow {
  id: string;
  project_path: string;
  project_name: string;
  status: string;
  last_activity: string;
  last_tool: string | null;
  last_tool_input: string | null;
  started_at: string;
  transcript_path: string | null;
  pending_state: string | null;
  pending_message: string | null;
}

export interface EventRecord {
  id: number;
  session_id: string;
  event_type: string;
  tool_name: string | null;
  tool_input: string | null;
  timestamp: string;
}

export interface FileAccessRecord {
  session_id?: string;
  file_path: string;
  access_type: string;
  timestamp?: string;
  last_access?: string;
}

export interface RawEventRecord {
  id: number;
  payload: string;
  received_at: string;
  endpoint: string;
  session_id: string | null;
  event_type: string | null;
}

interface PermissionRequestRow {
  id: number;
  session_id: string;
  project_path: string;
  project_name: string;
  tool_name: string;
  tool_input: string | null;
  message: string;
  requested_at: string;
  resolved_at: string | null;
  resolution: string | null;
}

// Singleton instance
export const db = new OverwatchDB();
