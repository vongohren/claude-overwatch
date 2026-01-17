# Claude Overwatch

A system-wide monitoring dashboard for all active Claude Code sessions.

> **Status**: Early development - see [ARCHITECTURE.md](./ARCHITECTURE.md) for design

## Vision

When you're running 10+ Claude Code sessions across different projects, it's easy to lose track of:
- Which sessions are active vs stale
- What each session is currently doing
- Which sessions are related (working on shared files)
- Where to find a specific session's terminal

Claude Overwatch provides a single dashboard to monitor all your Claude Code sessions in real-time.

## Features (Planned)

- **Real-time session overview** - See all active sessions, their status, and last action
- **Freshness indicators** - Know which sessions need attention
- **Cross-session intelligence** - Discover related sessions (shared files, same project area)
- **Terminal navigation** - Jump to a session's terminal window
- **Session history** - Track what was accomplished across sessions

## Quick Start

```bash
# Clone and install
git clone https://github.com/vongohren/claude-overwatch.git
cd claude-overwatch
npm install

# Initialize (sets up hooks and config)
npm run setup

# Start the dashboard
npm start
```

## How It Works

1. **Global hooks** in `~/.claude/settings.json` capture all Claude Code events
2. **Hook scripts** post events to the local Overwatch server
3. **Server** maintains session state and broadcasts via WebSocket
4. **Dashboard** displays real-time status of all sessions

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed design.

## Requirements

- macOS (Linux support planned)
- Node.js 18+
- Claude Code CLI

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build
```

## License

MIT
