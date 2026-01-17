// Claude Overwatch Server
// Receives hook events and maintains session state

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { broadcaster } from "./broadcaster.js";
import { scanner } from "./scanner.js";
import { store } from "./store.js";
import type { HookEvent } from "./types.js";

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
      // Just update activity for now
      const session = store.getSession(sessionId);
      if (session) {
        store.updateActivity(
          sessionId,
          session.lastTool,
          session.lastToolInput,
        );
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

// GET /scan - Trigger manual scan
fastify.post("/scan", async (_request, reply) => {
  const sessions = scanner.scan();
  return reply.send({ ok: true, discovered: sessions.length });
});

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
