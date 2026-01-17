// Session and event types for Claude Overwatch

export type SessionStatus = "active" | "idle" | "stale" | "ended";

export interface Session {
  id: string;
  projectPath: string;
  projectName: string;
  status: SessionStatus;
  lastActivity: Date;
  lastTool: string;
  lastToolInput: string;
  startedAt: Date;
  transcriptPath: string;
}

export type EventType =
  | "session-start"
  | "session-end"
  | "pre-tool"
  | "post-tool"
  | "notification"
  | "unknown";

export interface HookEvent {
  eventType: EventType;
  timestamp: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
  transcript_path?: string;
  message?: string;
}

export interface SessionResponse {
  id: string;
  projectPath: string;
  projectName: string;
  status: SessionStatus;
  lastActivity: string;
  lastTool: string;
  lastToolInput: string;
  startedAt: string;
  transcriptPath: string;
}

// WebSocket message types

// Server -> Client messages
export type ServerMessage =
  | { type: "sessions"; data: SessionResponse[] }
  | { type: "session-update"; data: SessionResponse }
  | { type: "session-ended"; id: string }
  | { type: "heartbeat" };

// Client -> Server messages
export type ClientMessage = { type: "subscribe" } | { type: "get-sessions" };
