// Claude Overwatch Server
// Receives hook events and maintains session state

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { broadcaster } from "./broadcaster.js";
import { db } from "./db.js";
import { scanner } from "./scanner.js";
import { store } from "./store.js";
import type { HookEvent, PermissionRequest } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PORT = 3142;

const fastify = Fastify({
  logger: {
    level: "info",
    transport: {
      target: "pino-pretty",
      options: {
        translateTime: "HH:MM:ss",
        ignore: "pid,hostname",
      },
    },
  },
});

// Register WebSocket plugin and set up route after it's ready
fastify.register(websocket);
fastify.after(() => {
  // WebSocket endpoint for real-time updates
  fastify.get("/ws", { websocket: true }, (socket, _request) => {
    fastify.log.info("WebSocket client connected");
    broadcaster.addClient(socket);
  });
});

// Serve dashboard static files
const dashboardDistPath = join(__dirname, "../../dashboard/dist");
if (existsSync(dashboardDistPath)) {
  fastify.register(fastifyStatic, {
    root: dashboardDistPath,
    prefix: "/",
  });

  // SPA fallback - serve index.html for unmatched routes
  fastify.setNotFoundHandler(async (_request, reply) => {
    return reply.sendFile("index.html");
  });
} else {
  fastify.log.warn("Dashboard not built yet. Run 'bun run build' first.");
}

// Set up broadcaster with session getter
broadcaster.setGetSessionsFn(() => {
  return store.getAllSessions().map((s) => store.toResponse(s));
});

// Parse tool input to a string summary
function summarizeToolInput(input: unknown): string {
  if (input === null || input === undefined) {
    return "";
  }
  if (typeof input === "string") {
    return input.length > 100 ? `${input.slice(0, 100)}...` : input;
  }
  if (typeof input === "object") {
    const str = JSON.stringify(input);
    return str.length > 100 ? `${str.slice(0, 100)}...` : str;
  }
  return String(input);
}

// Process incoming hook events
function processEvent(event: HookEvent): void {
  const sessionId = event.session_id;

  if (!sessionId) {
    fastify.log.warn({ event }, "Event missing session_id, ignoring");
    return;
  }

  switch (event.eventType) {
    case "session-start": {
      const cwd = event.cwd || process.cwd();
      const transcriptPath = event.transcript_path || "";
      const session = store.createSession(sessionId, cwd, transcriptPath);
      fastify.log.info(
        { sessionId, projectName: session.projectName },
        "Session started",
      );
      break;
    }

    case "pre-tool":
    case "post-tool": {
      const toolName = event.tool_name || "unknown";
      const toolInput = summarizeToolInput(event.tool_input);
      const session = store.updateActivity(sessionId, toolName, toolInput);
      if (session) {
        fastify.log.debug(
          { sessionId, tool: toolName },
          "Session activity updated",
        );
      } else {
        // Session doesn't exist yet, create it
        const cwd = event.cwd || process.cwd();
        const transcriptPath = event.transcript_path || "";
        store.createSession(sessionId, cwd, transcriptPath);
        store.updateActivity(sessionId, toolName, toolInput);
        fastify.log.info({ sessionId }, "Session created from tool event");
      }
      break;
    }

    case "session-end": {
      const session = store.endSession(sessionId);
      if (session) {
        fastify.log.info(
          { sessionId, projectName: session.projectName },
          "Session ended",
        );
      }
      break;
    }

    case "notification": {
      const session = store.getSession(sessionId);
      if (!session) {
        // Session doesn't exist, create it first
        const cwd = event.cwd || process.cwd();
        const transcriptPath = event.transcript_path || "";
        store.createSession(sessionId, cwd, transcriptPath);
      }

      // Check for pending state notifications
      const notificationType = event.notification_type;
      if (
        notificationType === "permission_prompt" ||
        notificationType === "idle_prompt" ||
        notificationType === "elicitation_dialog"
      ) {
        const message = event.message || "";
        store.setPendingState(sessionId, notificationType, message);
        fastify.log.info(
          { sessionId, notificationType },
          "Session awaiting approval",
        );
      } else {
        // Regular notification, just update activity
        const currentSession = store.getSession(sessionId);
        if (currentSession) {
          store.updateActivity(
            sessionId,
            currentSession.lastTool,
            currentSession.lastToolInput,
          );
        }
        fastify.log.debug({ sessionId }, "Notification received");
      }
      break;
    }

    default:
      fastify.log.warn({ eventType: event.eventType }, "Unknown event type");
  }
}

// POST /events - Receive hook events
fastify.post<{ Body: HookEvent }>("/events", async (request, reply) => {
  try {
    const event = request.body;

    // Log raw event for debugging before any processing
    db.logRawEvent(event, "/events", event.session_id, event.eventType);

    fastify.log.debug({ event }, "Received event");
    processEvent(event);
    return reply.status(200).send({ ok: true });
  } catch (error) {
    fastify.log.error({ error }, "Error processing event");
    return reply.status(400).send({ ok: false, error: "Invalid event" });
  }
});

// GET /sessions - List all sessions
fastify.get("/sessions", async (_request, reply) => {
  const sessions = store.getAllSessions();
  const response = sessions.map((s) => store.toResponse(s));
  return reply.send(response);
});

// GET /sessions/:id - Get session details
fastify.get<{ Params: { id: string } }>(
  "/sessions/:id",
  async (request, reply) => {
    const session = store.getSession(request.params.id);
    if (!session) {
      return reply.status(404).send({ error: "Session not found" });
    }
    return reply.send(store.toResponse(session));
  },
);

// GET /sessions/:id/events - Get session event history
fastify.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
  "/sessions/:id/events",
  async (request, reply) => {
    const limit = request.query.limit
      ? Number.parseInt(request.query.limit, 10)
      : 100;
    const events = store.getSessionEvents(request.params.id, limit);
    return reply.send(events);
  },
);

// GET /sessions/:id/files - Get files accessed by session
fastify.get<{ Params: { id: string } }>(
  "/sessions/:id/files",
  async (request, reply) => {
    const files = store.getSessionFiles(request.params.id);
    return reply.send(files);
  },
);

// Health check
fastify.get("/health", async (_request, reply) => {
  return reply.send({
    status: "ok",
    sessions: store.getAllSessions().length,
    wsClients: broadcaster.getClientCount(),
  });
});

// Permission analytics endpoints

// GET /analytics/permissions - Get permission request analytics summary
fastify.get("/analytics/permissions", async (_request, reply) => {
  const analytics = store.getPermissionAnalytics();
  const recentRequests = store.getPermissionRequests(20);
  return reply.send({
    ...analytics,
    recentRequests: recentRequests.map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      projectPath: r.projectPath,
      projectName: r.projectName,
      toolName: r.toolName,
      toolInput: r.toolInput,
      message: r.message,
      requestedAt: r.requestedAt.toISOString(),
      resolvedAt: r.resolvedAt?.toISOString() || null,
      resolution: r.resolution,
    })),
  });
});

// GET /analytics/permissions/requests - Get all permission requests
fastify.get<{
  Querystring: { limit?: string; tool?: string; project?: string };
}>("/analytics/permissions/requests", async (request, reply) => {
  const limit = request.query.limit
    ? Number.parseInt(request.query.limit, 10)
    : 100;
  const tool = request.query.tool;
  const project = request.query.project;

  let requests: PermissionRequest[];
  if (tool) {
    requests = store.getPermissionRequestsByTool(tool, limit);
  } else if (project) {
    requests = store.getPermissionRequestsByProject(project, limit);
  } else {
    requests = store.getPermissionRequests(limit);
  }

  return reply.send(
    requests.map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      projectPath: r.projectPath,
      projectName: r.projectName,
      toolName: r.toolName,
      toolInput: r.toolInput,
      message: r.message,
      requestedAt: r.requestedAt.toISOString(),
      resolvedAt: r.resolvedAt?.toISOString() || null,
      resolution: r.resolution,
    })),
  );
});

// GET /scan - Trigger manual scan
fastify.post("/scan", async (_request, reply) => {
  const sessions = scanner.scan();
  return reply.send({ ok: true, discovered: sessions.length });
});

// Debug endpoints for raw event inspection

// GET /debug/events - List all raw events
fastify.get<{ Querystring: { limit?: string; offset?: string } }>(
  "/debug/events",
  async (request, reply) => {
    const limit = request.query.limit
      ? Number.parseInt(request.query.limit, 10)
      : 100;
    const offset = request.query.offset
      ? Number.parseInt(request.query.offset, 10)
      : 0;
    const events = db.getRawEvents(limit, offset);
    return reply.send({
      count: events.length,
      events: events.map((e) => ({
        id: e.id,
        receivedAt: e.received_at,
        endpoint: e.endpoint,
        sessionId: e.session_id,
        eventType: e.event_type,
        payload: JSON.parse(e.payload),
      })),
    });
  },
);

// GET /debug/events/session/:sessionId - Events for a specific session
fastify.get<{ Params: { sessionId: string }; Querystring: { limit?: string } }>(
  "/debug/events/session/:sessionId",
  async (request, reply) => {
    const limit = request.query.limit
      ? Number.parseInt(request.query.limit, 10)
      : 100;
    const events = db.getRawEventsBySession(request.params.sessionId, limit);
    return reply.send({
      sessionId: request.params.sessionId,
      count: events.length,
      events: events.map((e) => ({
        id: e.id,
        receivedAt: e.received_at,
        endpoint: e.endpoint,
        eventType: e.event_type,
        payload: JSON.parse(e.payload),
      })),
    });
  },
);

// GET /debug/events/type/:eventType - Events by type
fastify.get<{ Params: { eventType: string }; Querystring: { limit?: string } }>(
  "/debug/events/type/:eventType",
  async (request, reply) => {
    const limit = request.query.limit
      ? Number.parseInt(request.query.limit, 10)
      : 100;
    const events = db.getRawEventsByType(request.params.eventType, limit);
    return reply.send({
      eventType: request.params.eventType,
      count: events.length,
      events: events.map((e) => ({
        id: e.id,
        receivedAt: e.received_at,
        endpoint: e.endpoint,
        sessionId: e.session_id,
        payload: JSON.parse(e.payload),
      })),
    });
  },
);

// DELETE /debug/events - Cleanup old raw events
fastify.delete<{ Querystring: { daysToKeep?: string } }>(
  "/debug/events",
  async (request, reply) => {
    const daysToKeep = request.query.daysToKeep
      ? Number.parseInt(request.query.daysToKeep, 10)
      : 7;
    const deleted = db.cleanupOldRawEvents(daysToKeep);
    return reply.send({ ok: true, deleted });
  },
);

// Start server
async function start() {
  try {
    await fastify.listen({ port: PORT, host: "0.0.0.0" });
    console.log(
      `Claude Overwatch server listening on http://localhost:${PORT}`,
    );

    // Start the session scanner with periodic re-scanning
    scanner.startPeriodicScan(60 * 1000); // Scan every 60 seconds
    fastify.log.info("Session scanner started");

    // Start WebSocket heartbeat
    broadcaster.startHeartbeat();
    fastify.log.info("WebSocket broadcaster started");
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

// Graceful shutdown
process.on("SIGINT", () => {
  scanner.stopPeriodicScan();
  broadcaster.close();
  fastify.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  scanner.stopPeriodicScan();
  broadcaster.close();
  fastify.close();
  process.exit(0);
});

start();
