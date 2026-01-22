// Session scanner for discovering existing Claude Code sessions
// Scans ~/.claude/projects/ for session files
// Only imports sessions that have a running Claude process

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { db } from "./db.js";
import { store } from "./store.js";
import type { Session } from "./types.js";

const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
const SCAN_INTERVAL = 60 * 1000; // 60 seconds

interface SessionIndexEntry {
  sessionId: string;
  fullPath: string;
  fileMtime: number;
  firstPrompt: string;
  messageCount: number;
  created: string;
  modified: string;
  gitBranch: string;
  projectPath: string;
  isSidechain: boolean;
}

interface SessionIndex {
  version: number;
  entries: SessionIndexEntry[];
}

interface JsonlUserMessage {
  type: "user";
  sessionId: string;
  cwd: string;
  timestamp: string;
  message?: {
    role: string;
    content: string;
  };
}

// How recently a file must be modified to be considered "active"
const ACTIVE_FILE_THRESHOLD = 5 * 60 * 1000; // 5 minutes

interface RunningClaudeProcess {
  pid: number;
  cwd: string;
  startedAt: Date;
}

// Get all running Claude CLI processes with their working directories
function getRunningClaudeProcesses(): RunningClaudeProcess[] {
  const processes: RunningClaudeProcess[] = [];

  try {
    // Get PIDs of claude processes (excluding node launcher and Claude.app)
    const psOutput = execSync(
      'ps aux | grep "claude" | grep -v grep | grep -v "Claude.app" | grep -v "node.*claude"',
      { encoding: "utf-8", timeout: 5000 },
    );

    const pids = psOutput
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const parts = line.trim().split(/\s+/);
        return parts[1]; // PID is second column
      })
      .filter((pid) => pid && /^\d+$/.test(pid));

    for (const pid of pids) {
      try {
        // Check if process has a TTY (filter out orphaned/zombie processes)
        const ttyOutput = execSync(`ps -o tty= -p ${pid}`, {
          encoding: "utf-8",
          timeout: 5000,
        }).trim();

        // Skip processes with no TTY (??) - these are orphaned
        if (!ttyOutput || ttyOutput === "??" || ttyOutput === "?") {
          continue;
        }

        // Get CWD using lsof
        const lsofOutput = execSync(`lsof -p ${pid} 2>/dev/null | grep cwd`, {
          encoding: "utf-8",
          timeout: 5000,
        });
        const cwdMatch = lsofOutput.match(/cwd\s+\S+\s+\S+\s+\S+\s+\S+\s+(.+)/);
        const cwd = cwdMatch ? cwdMatch[1].trim() : null;

        // Get start time
        const startOutput = execSync(`ps -o lstart= -p ${pid}`, {
          encoding: "utf-8",
          timeout: 5000,
        });
        const startedAt = new Date(startOutput.trim());

        if (cwd) {
          processes.push({
            pid: Number.parseInt(pid, 10),
            cwd,
            startedAt,
          });
        }
      } catch {
        // Skip processes we can't inspect
      }
    }
  } catch {
    // If ps fails, return empty array
  }

  return processes;
}

// Count processes per CWD
function countProcessesPerCwd(
  processes: RunningClaudeProcess[],
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const proc of processes) {
    counts.set(proc.cwd, (counts.get(proc.cwd) || 0) + 1);
  }
  return counts;
}

export class SessionScanner {
  private scanInterval: ReturnType<typeof setInterval> | null = null;
  private logger: { info: typeof console.log; warn: typeof console.warn };
  private processCountPerCwd: Map<string, number> = new Map();

  constructor(logger?: {
    info: typeof console.log;
    warn: typeof console.warn;
  }) {
    this.logger = logger ?? console;
  }

  // Refresh the list of running Claude processes
  private refreshRunningProcesses(): void {
    const processes = getRunningClaudeProcesses();
    this.processCountPerCwd = countProcessesPerCwd(processes);
    this.logger.info(
      {
        uniqueCwds: this.processCountPerCwd.size,
        totalProcesses: processes.length,
      },
      "Found running Claude processes",
    );
  }

  // Get number of running Claude processes for a project path
  // Only exact matches count - a session at /foo/bar is NOT live just because /foo has a process
  private getProcessCount(projectPath: string): number {
    return this.processCountPerCwd.get(projectPath) || 0;
  }

  // Get all project directories
  private getProjectDirs(): string[] {
    if (!existsSync(CLAUDE_PROJECTS_DIR)) {
      return [];
    }

    try {
      return readdirSync(CLAUDE_PROJECTS_DIR)
        .map((name) => join(CLAUDE_PROJECTS_DIR, name))
        .filter((path) => {
          try {
            return statSync(path).isDirectory();
          } catch {
            return false;
          }
        });
    } catch {
      return [];
    }
  }

  // Read sessions-index.json from a project directory
  private readSessionIndex(projectDir: string): SessionIndex | null {
    const indexPath = join(projectDir, "sessions-index.json");
    if (!existsSync(indexPath)) {
      return null;
    }

    try {
      const content = readFileSync(indexPath, "utf-8");
      return JSON.parse(content) as SessionIndex;
    } catch {
      return null;
    }
  }

  // Get the last tool used from a JSONL file (read from end efficiently)
  private getLastToolFromJsonl(jsonlPath: string): {
    tool: string;
    input: string;
  } | null {
    if (!existsSync(jsonlPath)) {
      return null;
    }

    try {
      const content = readFileSync(jsonlPath, "utf-8");
      const lines = content.trim().split("\n");

      // Search from the end for a tool_use message
      for (let i = lines.length - 1; i >= 0 && i >= lines.length - 100; i--) {
        try {
          const line = JSON.parse(lines[i]);
          if (line.type === "assistant" && line.message?.content) {
            const toolUse = line.message.content.find(
              (c: { type: string }) => c.type === "tool_use",
            );
            if (toolUse) {
              const inputStr =
                typeof toolUse.input === "string"
                  ? toolUse.input
                  : JSON.stringify(toolUse.input);
              return {
                tool: toolUse.name || "unknown",
                input:
                  inputStr.length > 100
                    ? `${inputStr.slice(0, 100)}...`
                    : inputStr,
              };
            }
          }
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      return null;
    }

    return null;
  }

  // Check if a session file was recently modified
  private isRecentlyModified(filePath: string): boolean {
    try {
      const stats = statSync(filePath);
      const elapsed = Date.now() - stats.mtimeMs;
      return elapsed < ACTIVE_FILE_THRESHOLD;
    } catch {
      return false;
    }
  }

  // Convert project path from filename format to actual path
  private projectPathFromDirName(dirName: string): string {
    // Dir names are like "-Users-vongohren-code-project"
    // Convert back to "/Users/vongohren/code/project"
    return dirName.replace(/-/g, "/");
  }

  // Scan a single project directory
  private scanProjectDir(projectDir: string): Session[] {
    const sessions: Session[] = [];
    const index = this.readSessionIndex(projectDir);

    if (index?.entries) {
      // Group entries by projectPath
      const entriesByPath = new Map<string, SessionIndexEntry[]>();
      for (const entry of index.entries) {
        const existing = entriesByPath.get(entry.projectPath) || [];
        existing.push(entry);
        entriesByPath.set(entry.projectPath, existing);
      }

      // For each projectPath, import N sessions where N = number of running processes
      for (const [projectPath, entries] of entriesByPath) {
        const processCount = this.getProcessCount(projectPath);
        if (processCount === 0) {
          continue;
        }

        // Sort by modified date descending, pick the N most recent
        entries.sort(
          (a, b) =>
            new Date(b.modified).getTime() - new Date(a.modified).getTime(),
        );

        // Import up to processCount sessions
        const toImport = entries.slice(0, processCount);

        for (const entry of toImport) {
          // Skip if we already know about this session
          if (store.hasSession(entry.sessionId)) {
            continue;
          }

          const isRecent = this.isRecentlyModified(entry.fullPath);
          const lastTool = this.getLastToolFromJsonl(entry.fullPath);

          // Check if we have a pending state from raw_events
          // This restores "waiting for input" state after server restart
          const lastPending = db.getLastPendingStateForSession(entry.sessionId);

          const session: Session = {
            id: entry.sessionId,
            projectPath: entry.projectPath,
            projectName:
              entry.projectPath.split("/").pop() || entry.projectPath,
            status: isRecent ? "active" : "stale",
            lastActivity: new Date(entry.modified),
            lastTool: lastTool?.tool || "",
            lastToolInput: lastTool?.input || "",
            startedAt: new Date(entry.created),
            transcriptPath: entry.fullPath,
            pendingState: lastPending?.pendingState || null,
            pendingMessage: lastPending?.message || "",
          };

          if (lastPending) {
            this.logger.info(
              {
                sessionId: entry.sessionId,
                pendingState: lastPending.pendingState,
              },
              "Restored pending state from raw events",
            );
          }

          sessions.push(session);
        }
      }
    }

    return sessions;
  }

  // Mark sessions as ended if their process is no longer running
  private cleanupDeadSessions(): number {
    let endedCount = 0;

    // Group active sessions by projectPath
    const sessionsByPath = new Map<string, Session[]>();
    for (const session of store.getAllSessions()) {
      if (session.status === "ended") continue;
      const existing = sessionsByPath.get(session.projectPath) || [];
      existing.push(session);
      sessionsByPath.set(session.projectPath, existing);
    }

    // For each projectPath, keep only N sessions where N = process count
    for (const [projectPath, sessions] of sessionsByPath) {
      const processCount = this.getProcessCount(projectPath);

      // Sort by lastActivity descending (most recent first)
      sessions.sort(
        (a, b) => b.lastActivity.getTime() - a.lastActivity.getTime(),
      );

      // End sessions beyond the process count
      for (let i = processCount; i < sessions.length; i++) {
        store.endSession(sessions[i].id);
        endedCount++;
        this.logger.info(
          { sessionId: sessions[i].id, project: sessions[i].projectName },
          "Session ended (excess session for this path)",
        );
      }

      // If no processes at all, end all sessions for this path
      if (processCount === 0) {
        for (const session of sessions) {
          store.endSession(session.id);
          endedCount++;
          this.logger.info(
            { sessionId: session.id, project: session.projectName },
            "Session ended (no running process)",
          );
        }
      }
    }

    return endedCount;
  }

  // Perform a full scan of all projects
  scan(): Session[] {
    // First, refresh the list of running Claude processes
    this.refreshRunningProcesses();

    // Clean up sessions whose processes are no longer running
    const endedCount = this.cleanupDeadSessions();
    if (endedCount > 0) {
      this.logger.info({ endedCount }, "Cleaned up dead sessions");
    }

    const allSessions: Session[] = [];
    const projectDirs = this.getProjectDirs();

    for (const dir of projectDirs) {
      try {
        const sessions = this.scanProjectDir(dir);
        allSessions.push(...sessions);
      } catch (error) {
        this.logger.warn({ dir, error }, "Error scanning project directory");
      }
    }

    // Add discovered sessions to the store
    for (const session of allSessions) {
      // Use internal method to add without triggering hooks
      store.importSession(session);
    }

    this.logger.info(
      { count: allSessions.length },
      "Scan complete, live sessions discovered",
    );

    return allSessions;
  }

  // Start periodic scanning
  startPeriodicScan(intervalMs: number = SCAN_INTERVAL): void {
    if (this.scanInterval) {
      return; // Already running
    }

    // Initial scan
    this.scan();

    // Set up periodic scans
    this.scanInterval = setInterval(() => {
      this.scan();
    }, intervalMs);

    this.logger.info({ intervalMs }, "Started periodic session scanning");
  }

  // Stop periodic scanning
  stopPeriodicScan(): void {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      this.scanInterval = null;
      this.logger.info("Stopped periodic session scanning");
    }
  }
}

export const scanner = new SessionScanner();
