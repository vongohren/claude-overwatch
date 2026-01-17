# Claude Overwatch - Architecture Design

A system-wide monitoring dashboard for all active Claude Code sessions.

## Goals

1. **Quick status overview** - See all active sessions, their projects, last action, freshness
2. **Cross-session intelligence** - Connect dots between sessions (shared files, related projects)
3. **Session navigation** - Jump to specific terminal windows (best-effort with modern terminals)
4. **Clean, expandable architecture** - Easy to add features, maintain, and understand

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Claude Code Instances                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│  │ Session 1│  │ Session 2│  │ Session 3│  │ Session N│  ...       │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘            │
│       │             │             │             │                   │
│       └─────────────┴─────────────┴─────────────┘                   │
│                           │ Hooks (stdin JSON)                      │
└───────────────────────────┼─────────────────────────────────────────┘
                            ▼
┌───────────────────────────────────────────────────────────────────┐
│                     Hook Scripts (Bash)                            │
│  ~/.claude/hooks/overwatch-hook.sh                                 │
│  - Receives JSON from Claude Code hooks                            │
│  - POSTs to local Overwatch server                                 │
└───────────────────────────┬───────────────────────────────────────┘
                            │ HTTP POST
                            ▼
┌───────────────────────────────────────────────────────────────────┐
│                    Overwatch Server (Node.js)                      │
│                                                                    │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐   │
│  │  Event Receiver │  │ Session Scanner │  │ Session Linker  │   │
│  │  POST /events   │  │ Scans ~/.claude │  │ Finds relations │   │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘   │
│           │                    │                    │             │
│           └────────────────────┴────────────────────┘             │
│                               │                                    │
│                    ┌──────────▼──────────┐                        │
│                    │    State Manager    │                        │
│                    │  (In-memory + SQL)  │                        │
│                    └──────────┬──────────┘                        │
│                               │                                    │
│           ┌───────────────────┼───────────────────┐               │
│           │                   │                   │               │
│  ┌────────▼────────┐ ┌───────▼───────┐ ┌────────▼────────┐      │
│  │  REST API       │ │  WebSocket    │ │  SQLite Store   │      │
│  │  GET /sessions  │ │  Real-time    │ │  History/Links  │      │
│  └─────────────────┘ └───────┬───────┘ └─────────────────┘      │
│                               │                                    │
└───────────────────────────────┼────────────────────────────────────┘
                                │ WebSocket
                                ▼
┌───────────────────────────────────────────────────────────────────┐
│                      Web Dashboard (Browser)                       │
│                                                                    │
│  ┌─────────────────────────────────────────────────────────────┐  │
│  │  Active Sessions                              [Refresh] [⚙]  │  │
│  │                                                              │  │
│  │  ┌─────────────────────────────────────────────────────────┐│  │
│  │  │ 🟢 claude-overwatch     │ Edit: ARCH... │ 2s ago  │ ▶  ││  │
│  │  │    ~/code/personal-projects/claude-overwatch            ││  │
│  │  ├─────────────────────────────────────────────────────────┤│  │
│  │  │ 🟡 my-api-project       │ Bash: npm test│ 45s ago │ ▶  ││  │
│  │  │    ~/code/work/my-api                                   ││  │
│  │  ├─────────────────────────────────────────────────────────┤│  │
│  │  │ 🔴 old-feature-branch   │ Read: utils.ts│ 5m ago  │ ▶  ││  │
│  │  │    ~/code/work/frontend                                 ││  │
│  │  └─────────────────────────────────────────────────────────┘│  │
│  │                                                              │  │
│  │  Related Sessions (shared context):                          │  │
│  │  • my-api-project ↔ frontend (share: src/types/api.ts)      │  │
│  │                                                              │  │
│  └─────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

## Components

### 1. Global Hook Configuration

Location: `~/.claude/settings.json`

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "~/.claude/hooks/overwatch.sh session-start" }]
    }],
    "SessionEnd": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "~/.claude/hooks/overwatch.sh session-end" }]
    }],
    "PreToolUse": [{
      "matcher": ".*",
      "hooks": [{ "type": "command", "command": "~/.claude/hooks/overwatch.sh pre-tool" }]
    }],
    "PostToolUse": [{
      "matcher": ".*",
      "hooks": [{ "type": "command", "command": "~/.claude/hooks/overwatch.sh post-tool" }]
    }],
    "Notification": [{
      "matcher": "",
      "hooks": [{ "type": "command", "command": "~/.claude/hooks/overwatch.sh notification" }]
    }]
  }
}
```

### 2. Hook Script

`~/.claude/hooks/overwatch.sh`:
- Reads JSON from stdin
- Enriches with event type from $1
- POSTs to `http://localhost:3142/events`
- Non-blocking (uses `curl ... &` and exits immediately)
- Always exits 0 to not block Claude Code

### 3. Overwatch Server

**Tech Stack**: Node.js + TypeScript + SQLite + WebSocket

**Endpoints**:
- `POST /events` - Receive hook events
- `GET /sessions` - List all active sessions
- `GET /sessions/:id` - Get session details
- `GET /sessions/:id/transcript` - Get session transcript
- `GET /relations` - Get cross-session relations
- `WS /ws` - Real-time updates

**State Management**:
- In-memory map of active sessions (fast access)
- SQLite for persistence and history
- Periodic scan of `~/.claude/projects/` for backup discovery

### 4. Session Data Model

```typescript
interface Session {
  id: string;                    // UUID from Claude Code
  projectPath: string;           // Working directory
  projectName: string;           // Derived folder name
  status: 'active' | 'idle' | 'stale' | 'ended';

  // Activity tracking
  lastActivity: Date;
  lastTool: string;              // "Read", "Edit", "Bash", etc.
  lastToolInput: string;         // Truncated file path or command
  lastMessage: string;           // Last assistant message (truncated)

  // Terminal info (best-effort)
  terminalPid?: number;
  terminalTty?: string;
  terminalApp?: string;          // "Warp", "Ghostty", "iTerm", etc.

  // Cross-session linking
  filesAccessed: Set<string>;    // Absolute paths
  relatedSessions: string[];     // Session IDs with shared files

  // Metadata
  startedAt: Date;
  transcriptPath: string;        // Path to JSONL file
}
```

### 5. Cross-Session Intelligence ("Connecting Dots")

**Automatic Detection**:
- Track all file paths accessed by each session
- When Session A accesses files that Session B also accessed, link them
- Rank relationships by number of shared files and recency

**Manual Grouping**:
- Allow user to tag sessions (e.g., "feature-auth", "refactor-v2")
- Create session groups for related work
- Export combined context for new sessions

**Context Merging** (Future):
- Generate summary of learnings across related sessions
- Create a "briefing" markdown for starting a new session
- Track decisions and outcomes across sessions

### 6. Terminal Window Navigation

**Challenge**: Warp and Ghostty have limited automation APIs compared to iTerm2.

**Approach**:
1. **Process Mapping**: When a session starts, capture the TTY from `/dev/tty` and store it
2. **PID Discovery**: Use `ps` to find the terminal process owning that TTY
3. **Window Matching**:
   - For Warp: Use AppleScript to find windows by PID or working directory
   - For Ghostty: Similar AppleScript approach
   - Fallback: Open the project folder in Finder or show a notification

**Best-Effort Navigation Script**:
```bash
#!/bin/bash
# Find terminal window by session's working directory
osascript -e "
  tell application \"System Events\"
    set frontProc to first process whose unix id is $PID
    set frontmost of frontProc to true
  end tell
"
```

### 7. Dashboard UI

**Framework**: Svelte (lightweight) or plain HTML/CSS/JS (simplest)

**Features**:
- Session list with status indicators (🟢 active, 🟡 idle, 🔴 stale)
- Last action and time since activity
- Project path and name
- Click to attempt navigation to terminal
- Relations view showing connected sessions
- Search/filter by project name
- Session grouping and tagging

**Status Thresholds**:
- 🟢 Active: Activity within last 30 seconds
- 🟡 Idle: Activity within last 5 minutes
- 🔴 Stale: No activity for 5+ minutes
- ⚫ Ended: Session terminated

## Directory Structure

```
claude-overwatch/
├── package.json
├── tsconfig.json
├── README.md
├── ARCHITECTURE.md
│
├── hooks/                      # Hook scripts
│   └── overwatch.sh           # Main hook script
│
├── server/                     # Backend server
│   ├── src/
│   │   ├── index.ts           # Entry point
│   │   ├── event-handler.ts   # Process incoming events
│   │   ├── session-store.ts   # Session state management
│   │   ├── session-scanner.ts # Scan ~/.claude for sessions
│   │   ├── session-linker.ts  # Cross-session intelligence
│   │   ├── terminal-mapper.ts # Terminal window mapping
│   │   └── db.ts              # SQLite operations
│   └── package.json
│
├── dashboard/                  # Web UI
│   ├── src/
│   │   ├── index.html
│   │   ├── app.ts
│   │   ├── components/
│   │   │   ├── SessionList.ts
│   │   │   ├── SessionCard.ts
│   │   │   └── RelationsGraph.ts
│   │   └── styles.css
│   └── package.json
│
└── cli/                        # Optional CLI interface
    ├── src/
    │   └── index.ts           # Terminal-based status view
    └── package.json
```

## Setup Flow

1. **Install**: `npm install -g claude-overwatch`
2. **Initialize**: `claude-overwatch init`
   - Creates `~/.claude/hooks/overwatch.sh`
   - Merges hooks config into `~/.claude/settings.json`
   - Creates data directory `~/.claude-overwatch/`
3. **Start Server**: `claude-overwatch start`
   - Starts server on port 3142
   - Opens dashboard in browser
4. **Ongoing**: Server runs in background, dashboard shows real-time state

## Future Enhancements

1. **Session Resume**: Quick-resume stale sessions from dashboard
2. **Cost Tracking**: Integrate with Claude's usage API for cost per session
3. **Session Templates**: Start new sessions with context from related sessions
4. **Notifications**: Alert when sessions go stale or complete
5. **Multi-Machine**: Sync session state across machines
6. **AI Summaries**: Use Claude to summarize what each session accomplished

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Hook overhead slows Claude Code | Hooks POST async and exit immediately |
| Warp/Ghostty API limitations | Best-effort navigation, fallback to notification |
| Session file format changes | Abstract parsing, handle gracefully |
| Server not running | Hooks fail silently, sessions still work |
| Too many events | Debounce, only store significant events |

## Port and Paths

- **Server Port**: 3142 (overwatch ≈ oversight ≈ 3142)
- **Data Directory**: `~/.claude-overwatch/`
- **Database**: `~/.claude-overwatch/overwatch.db`
- **Hook Script**: `~/.claude/hooks/overwatch.sh`
