// UI rendering functions for the dashboard

import type { FilterType } from "./index";
import type { PendingState, SessionResponse, SessionStatus } from "./types";

const STATUS_ICONS: Record<SessionStatus, string> = {
  active: "\u{1F7E2}", // 🟢
  idle: "\u{1F7E1}", // 🟡
  stale: "\u{1F534}", // 🔴
  ended: "\u{26AB}", // ⚫
};

const STATUS_LABELS: Record<SessionStatus, string> = {
  active: "Active",
  idle: "Idle",
  stale: "Stale",
  ended: "Ended",
};

const PENDING_ICONS: Record<NonNullable<PendingState>, string> = {
  permission_prompt: "\u{1F514}", // 🔔
  idle_prompt: "\u{23F3}", // ⏳
  elicitation_dialog: "\u{2753}", // ❓
};

const PENDING_LABELS: Record<NonNullable<PendingState>, string> = {
  permission_prompt: "Awaiting Permission",
  idle_prompt: "Awaiting Input",
  elicitation_dialog: "Awaiting Response",
};

export function formatTimeAgo(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) {
    return `${diffSec}s ago`;
  }
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) {
    return `${diffHour}h ago`;
  }
  const diffDay = Math.floor(diffHour / 24);
  return `${diffDay}d ago`;
}

export function truncatePath(path: string, maxLen = 40): string {
  if (path.length <= maxLen) {
    return path;
  }
  const parts = path.split("/");
  let result = `~/${parts[parts.length - 1]}`;
  for (let i = parts.length - 2; i >= 0 && result.length < maxLen; i--) {
    const newResult = `~/${parts[i]}/${result.slice(2)}`;
    if (newResult.length > maxLen) {
      break;
    }
    result = newResult;
  }
  return result;
}

export function formatToolAction(tool: string, input: string): string {
  if (!tool) {
    return "No activity";
  }
  const shortInput = input.length > 50 ? `${input.slice(0, 50)}...` : input;
  return `${tool}: ${shortInput || "(no input)"}`;
}

export function renderSessionCard(session: SessionResponse): string {
  const statusIcon = STATUS_ICONS[session.status];
  const statusLabel = STATUS_LABELS[session.status];
  const timeAgo = formatTimeAgo(session.lastActivity);
  const projectPath = truncatePath(session.projectPath);
  const lastAction = formatToolAction(session.lastTool, session.lastToolInput);

  const isPending = session.pendingState !== null;
  const pendingClass = isPending ? " pending-approval" : "";
  const pendingBadge = isPending
    ? `<span class="status-badge pending">${PENDING_ICONS[session.pendingState]} ${PENDING_LABELS[session.pendingState]}</span>`
    : `<span class="status-badge ${session.status}">${statusIcon} ${statusLabel}</span>`;
  const pendingMessage =
    isPending && session.pendingMessage
      ? `<div class="pending-message">${escapeHtml(session.pendingMessage)}</div>`
      : "";

  return `
    <div class="session-card status-${session.status}${pendingClass}" data-session-id="${session.id}">
      <div class="session-header">
        ${pendingBadge}
        <span class="project-name">${escapeHtml(session.projectName)}</span>
        <span class="time-ago">${timeAgo}</span>
      </div>
      <div class="session-path">${escapeHtml(projectPath)}</div>
      ${pendingMessage}
      <div class="session-action">${escapeHtml(lastAction)}</div>
    </div>
  `;
}

export function renderSessionList(sessions: SessionResponse[]): string {
  if (sessions.length === 0) {
    return `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <div class="empty-message">No Claude sessions detected</div>
        <div class="empty-hint">Start a Claude Code session to see it here</div>
      </div>
    `;
  }

  // Sort: pending first, then by status, then by last activity
  const sorted = [...sessions].sort((a, b) => {
    // Pending sessions always come first
    const aPending = a.pendingState !== null ? 0 : 1;
    const bPending = b.pendingState !== null ? 0 : 1;
    if (aPending !== bPending) {
      return aPending - bPending;
    }

    // Then by status
    const statusOrder: Record<SessionStatus, number> = {
      active: 0,
      idle: 1,
      stale: 2,
      ended: 3,
    };
    const statusDiff = statusOrder[a.status] - statusOrder[b.status];
    if (statusDiff !== 0) {
      return statusDiff;
    }

    // Then by last activity (most recent first)
    return (
      new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
    );
  });

  return sorted.map(renderSessionCard).join("");
}

export function renderHeader(connected: boolean, sessionCount: number): string {
  const connectionStatus = connected
    ? '<span class="connection-status connected">Connected</span>'
    : '<span class="connection-status disconnected">Disconnected</span>';

  return `
    <div class="header-left">
      <h1>Claude Overwatch</h1>
      <span class="session-count">${sessionCount} session${sessionCount !== 1 ? "s" : ""}</span>
    </div>
    <div class="header-right">
      ${connectionStatus}
      <button class="refresh-btn" title="Refresh">↻</button>
    </div>
  `;
}

export function renderFilterBar(
  currentFilter: FilterType,
  searchQuery: string,
): string {
  const filters: Array<{ value: FilterType; label: string }> = [
    { value: "not-ended", label: "Active Sessions" },
    { value: "all", label: "All Sessions" },
    { value: "active", label: "🟢 Active" },
    { value: "idle", label: "🟡 Idle" },
    { value: "stale", label: "🔴 Stale" },
    { value: "ended", label: "⚫ Ended" },
  ];

  const filterOptions = filters
    .map(
      (f) =>
        `<option value="${f.value}" ${currentFilter === f.value ? "selected" : ""}>${f.label}</option>`,
    )
    .join("");

  return `
    <select class="filter-select" id="status-filter">
      ${filterOptions}
    </select>
    <input
      type="text"
      class="search-input"
      id="search-input"
      placeholder="Search projects..."
      value="${escapeHtml(searchQuery)}"
    />
  `;
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
