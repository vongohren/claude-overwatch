// Types matching the server types for WebSocket communication

export type SessionStatus = "active" | "idle" | "stale" | "ended";

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

export type ServerMessage =
  | { type: "sessions"; data: SessionResponse[] }
  | { type: "session-update"; data: SessionResponse }
  | { type: "session-ended"; id: string }
  | { type: "heartbeat" };
