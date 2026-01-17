// SQLite database for Claude Overwatch
// Uses bun:sqlite for persistence

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Session, SessionStatus } from "./types.js";

const DB_DIR = join(homedir(), ".claude-overwatch");
const DB_PATH = join(DB_DIR, "overwatch.db");

// Schema version for migrations
const SCHEMA_VERSION = 1;

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

    -- Indexes for performance
    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_file_access_path ON file_access(file_path);
    CREATE INDEX IF NOT EXISTS idx_file_access_session ON file_access(session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity);
  `);

  // Set schema version
  const versionRow = db.query("SELECT version FROM schema_version").get();
  if (!versionRow) {
    db.exec(`INSERT INTO schema_version (version) VALUES (${SCHEMA_VERSION})`);
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
  }

  // Session CRUD operations

  upsertSession(session: Session): void {
    const stmt = this.db.prepare(`
      INSERT INTO sessions (
        id, project_path, project_name, status, last_activity,
        last_tool, last_tool_input, started_at, transcript_path
      ) VALUES (
        $id, $projectPath, $projectName, $status, $lastActivity,
        $lastTool, $lastToolInput, $startedAt, $transcriptPath
      )
      ON CONFLICT(id) DO UPDATE SET
        status = $status,
        last_activity = $lastActivity,
        last_tool = $lastTool,
        last_tool_input = $lastToolInput
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
    });
  }

  getSession(id: string): Session | null {
    const row = this.db
      .query(
        `
      SELECT id, project_path, project_name, status, last_activity,
             last_tool, last_tool_input, started_at, transcript_path
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
             last_tool, last_tool_input, started_at, transcript_path
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
             last_tool, last_tool_input, started_at, transcript_path
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
      SET status = 'ended', ended_at = $endedAt
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
          status = $status
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

// Singleton instance
export const db = new OverwatchDB();
