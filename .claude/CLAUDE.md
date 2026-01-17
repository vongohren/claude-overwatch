# Claude Overwatch

A system-wide monitoring dashboard for all active Claude Code sessions.

## Project Structure

Monorepo using Bun workspaces:

```
packages/
├── server/     # Fastify backend, WebSocket, SQLite (bun:sqlite)
├── dashboard/  # Vite web UI
└── cli/        # Terminal status viewer
scripts/
└── setup.js    # Installation wizard
```

## Tech Stack

- **Runtime**: Bun
- **Linting/Formatting**: Biome
- **Server**: Fastify + @fastify/websocket
- **Database**: bun:sqlite (built-in SQLite)
- **Dashboard**: Vite (vanilla TypeScript for now)
- **Types**: TypeScript with strict mode

## Commands

```bash
bun install          # Install dependencies
bun run build        # Build all packages
bun run dev          # Dev mode with watch
bun run lint         # Lint with Biome
bun run lint:fix     # Auto-fix lint issues
bun run format       # Format with Biome
bun run check        # Combined lint + format check
bun run start        # Start the server
```

## Code Style

- Use Biome for all linting and formatting (no ESLint/Prettier)
- Double quotes, semicolons, 2-space indent (configured in biome.json)
- Prefer named exports over default exports
- Use `bun:sqlite` for database operations (not better-sqlite3)
- No `any` types - use `unknown` with type guards

## Architecture Overview

1. **Hook scripts** in `~/.claude/hooks/` capture Claude Code events
2. **Server** receives events via `POST /events`, stores in SQLite, broadcasts via WebSocket
3. **Dashboard** connects to WebSocket for real-time updates
4. **CLI** provides terminal-based status view

Key server port: **3142**

## Data Locations

- Server data: `~/.claude-overwatch/`
- Database: `~/.claude-overwatch/overwatch.db`
- Hook script: `~/.claude/hooks/overwatch.sh`

## Session Status Thresholds

- 🟢 Active: < 30 seconds since last activity
- 🟡 Idle: < 5 minutes
- 🔴 Stale: > 5 minutes
- ⚫ Ended: Session terminated

## Key Interfaces

```typescript
interface Session {
  id: string;
  projectPath: string;
  projectName: string;
  status: 'active' | 'idle' | 'stale' | 'ended';
  lastActivity: Date;
  lastTool: string;
  lastToolInput: string;
  filesAccessed: Set<string>;
  relatedSessions: string[];
}
```

## Server Endpoints

- `POST /events` - Receive hook events
- `GET /sessions` - List all sessions
- `GET /sessions/:id` - Session details
- `WS /ws` - Real-time updates

## When Making Changes

- Run `bun run check` before committing
- Test with `bun run build` to ensure compilation works
- Server and CLI use `bun build` for bundling
- Dashboard uses Vite for bundling
