// Session and event types for Claude Overwatch

export type SessionStatus = "active" | "idle" | "stale" | "ended";

export type PendingState =
  | "permission_prompt"
  | "idle_prompt"
  | "elicitation_dialog"
  | null;

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
  pendingState: PendingState;
  pendingMessage: string;
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
  notification_type?: string;
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
  pendingState: PendingState;
  pendingMessage: string;
}

// Permission request tracking for analytics
export type PermissionResolution = "approved" | "denied" | "timeout" | null;

export interface PermissionRequest {
  id: number;
  sessionId: string;
  projectPath: string;
  projectName: string;
  toolName: string;
  toolInput: string;
  message: string;
  requestedAt: Date;
  resolvedAt: Date | null;
  resolution: PermissionResolution;
}

export interface PermissionRequestResponse {
  id: number;
  sessionId: string;
  projectPath: string;
  projectName: string;
  toolName: string;
  toolInput: string;
  message: string;
  requestedAt: string;
  resolvedAt: string | null;
  resolution: PermissionResolution;
}

export interface PermissionAnalytics {
  totalRequests: number;
  byTool: Record<string, number>;
  byProject: Record<string, number>;
  byResolution: Record<string, number>;
  recentRequests: PermissionRequestResponse[];
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
