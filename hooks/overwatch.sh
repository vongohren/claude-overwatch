#!/bin/bash
# Claude Overwatch Hook Script
# Captures Claude Code events and sends them to the Overwatch server
#
# Usage: overwatch.sh <event-type>
# Reads JSON from stdin, enriches with event type, and POSTs to server

set -o pipefail

# Configuration
OVERWATCH_URL="${OVERWATCH_URL:-http://localhost:3142/events}"
EVENT_TYPE="${1:-unknown}"

# Read stdin (the hook data from Claude Code)
INPUT=$(cat)

# If no input, create minimal payload
if [ -z "$INPUT" ]; then
  INPUT='{}'
fi

# Enrich with event type and timestamp
# Use jq if available, otherwise use simple string manipulation
if command -v jq &> /dev/null; then
  PAYLOAD=$(echo "$INPUT" | jq -c --arg type "$EVENT_TYPE" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '. + {eventType: $type, timestamp: $ts}')
else
  # Fallback: wrap in envelope without jq
  PAYLOAD="{\"eventType\":\"$EVENT_TYPE\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"data\":$INPUT}"
fi

# Send to server in background (non-blocking)
# Redirect output to avoid any noise, timeout after 5 seconds
(curl -s -X POST \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  --connect-timeout 2 \
  --max-time 5 \
  "$OVERWATCH_URL" \
  > /dev/null 2>&1 &)

# Always exit 0 to never block Claude Code
exit 0
