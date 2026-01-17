// Session scanner for discovering existing Claude Code sessions
// Scans ~/.claude/projects/ for session files

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

export class SessionScanner {
  private scanInterval: ReturnType<typeof setInterval> | null = null;
  private logger: { info: typeof console.log; warn: typeof console.warn };

  constructor(logger?: {
    info: typeof console.log;
    warn: typeof console.warn;
  }) {
    this.logger = logger ?? console;
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
      for (const entry of index.entries) {
        // Skip if we already know about this session
        if (store.getSession(entry.sessionId)) {
          continue;
        }

        const isRecent = this.isRecentlyModified(entry.fullPath);
        const lastTool = this.getLastToolFromJsonl(entry.fullPath);

        const session: Session = {
          id: entry.sessionId,
          projectPath: entry.projectPath,
          projectName: entry.projectPath.split("/").pop() || entry.projectPath,
          status: isRecent ? "active" : "stale",
          lastActivity: new Date(entry.modified),
          lastTool: lastTool?.tool || "",
          lastToolInput: lastTool?.input || "",
          startedAt: new Date(entry.created),
          transcriptPath: entry.fullPath,
        };

        sessions.push(session);
      }
    }

    return sessions;
  }

  // Perform a full scan of all projects
  scan(): Session[] {
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
      "Scan complete, sessions discovered",
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
