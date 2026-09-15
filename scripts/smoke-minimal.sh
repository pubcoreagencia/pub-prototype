#!/usr/bin/env bash
set -euo pipefail

# Load bootstrap output
OUTPUT_FILE="scripts/bootstrap-output.json"
if [[ ! -f "$OUTPUT_FILE" ]]; then
  echo "Bootstrap output not found: $OUTPUT_FILE"
  exit 1
fi

# Extract values
API_BASE_URL=$(jq -r '.apiBaseUrl' "$OUTPUT_FILE")
WORKSPACE_ID=$(jq -r '.workspaceId' "$OUTPUT_FILE")
PROJECT_ID=$(jq -r '.projectId' "$OUTPUT_FILE")
SESSION_ID=$(jq -r '.sessionId' "$OUTPUT_FILE")
TOKEN=$(jq -r '.token // "test-token"' "$OUTPUT_FILE" 2>/dev/null || echo "test-token")

# Health check
if ! curl -sSf "$API_BASE_URL/health" >/dev/null; then
  echo "API health check failed"
  exit 1
fi

# Verify entities exist
verify() {
  local url=$1
  local desc=$2
  if ! curl -s -H "Authorization: Bearer $TOKEN" "$url" | jq -e '.' >/dev/null; then
    echo "Failed to verify $desc ($url)"
    exit 1
  fi
}

verify "$API_BASE_URL/api/workspaces" "workspaces list"
verify "$API_BASE_URL/api/projects/$PROJECT_ID" "project"
verify "$API_BASE_URL/prototype/sessions/$SESSION_ID" "session"

# Worker health check
WORKER_PORT="${PP_WORKER_PORT:-3002}"
if ! curl -sSf "http://localhost:$WORKER_PORT/ready" >/dev/null 2>&1; then
  if ! curl -sSf "http://localhost:$WORKER_PORT/" >/dev/null 2>&1; then
    echo "Error: Dedicated worker health check failed on port $WORKER_PORT. Is pp:worker running?"
    exit 1
  fi
fi

# Send a prompt
PROMPT_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_BASE_URL/prototype/sessions/$SESSION_ID/prompts" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Hello from bootstrap smoke test"}')

PROMPT_HTTP_CODE=$(echo "$PROMPT_RESPONSE" | tail -n1)
PROMPT_BODY=$(echo "$PROMPT_RESPONSE" | sed '$d')

if [[ "$PROMPT_HTTP_CODE" != "202" ]]; then
  echo "Error: Expected HTTP 202 from prompt endpoint, got $PROMPT_HTTP_CODE"
  echo "$PROMPT_BODY"
  exit 1
fi

TASK_ID=$(echo "$PROMPT_BODY" | jq -r '.task.id // empty')
if [[ -z "$TASK_ID" ]]; then
  echo "Error: Prompt response did not include a valid task id"
  exit 1
fi

echo "Prompt submitted successfully (task: $TASK_ID). Waiting for worker execution..."

# Poll for session ready
MAX_ATTEMPTS=60
INTERVAL=2
attempt=0
SESSION_READY=0
while [[ $attempt -lt $MAX_ATTEMPTS ]]; do
  SESSION_DATA=$(curl -s -H "Authorization: Bearer $TOKEN" "$API_BASE_URL/prototype/sessions/$SESSION_ID")
  STATUS=$(echo "$SESSION_DATA" | jq -r '.session.status // empty')
  if [[ "$STATUS" == "READY" ]]; then
    echo "Session is READY"
    SESSION_READY=1
    break
  elif [[ "$STATUS" == "FAILED" ]]; then
    echo "Error: Session processing failed"
    echo "$SESSION_DATA" | jq .
    exit 1
  fi
  ((attempt++))
  sleep $INTERVAL
done

if [[ $SESSION_READY -ne 1 ]]; then
  echo "Timeout waiting for session to become READY. Is the worker running?"
  exit 1
fi

# Confirm checkpoints exist
CHECKPOINT_COUNT=$(echo "$SESSION_DATA" | jq -r '.checkpoints | length')
if [[ -z "$CHECKPOINT_COUNT" || "$CHECKPOINT_COUNT" -lt 1 ]]; then
  echo "Error: Session status is READY but no checkpoints were recorded in database"
  exit 1
fi
LAST_CHECKPOINT_ID=$(echo "$SESSION_DATA" | jq -r '.checkpoints[-1].id')
LAST_COMMIT_SHA=$(echo "$SESSION_DATA" | jq -r '.checkpoints[-1].commitSha // empty')
echo "Checkpoint verified: $LAST_CHECKPOINT_ID (commit: ${LAST_COMMIT_SHA:-none})"

# Get preview URL
PREVIEW_URL=$(echo "$SESSION_DATA" | jq -r '.session.previewUrl // empty')
if [[ -z "$PREVIEW_URL" ]]; then
  echo "Error: No preview URL recorded on session"
  exit 1
fi

# Fetch preview
PREVIEW_FETCH_URL="$PREVIEW_URL"
if [[ "$PREVIEW_URL" == /* ]]; then
  PREVIEW_FETCH_URL="$API_BASE_URL$PREVIEW_URL"
fi

PREVIEW_CONTENT=$(curl -sSf "$PREVIEW_FETCH_URL")
if [[ -z "$PREVIEW_CONTENT" ]]; then
  echo "Error: Preview request returned empty content"
  exit 1
fi
echo "Preview fetched successfully from $PREVIEW_FETCH_URL"

# List files and verify content
FILES_RESPONSE=$(curl -s -H "Authorization: Bearer $TOKEN" "$API_BASE_URL/prototype/sessions/$SESSION_ID/files")
COUNT=$(echo "$FILES_RESPONSE" | jq -r '.files | length')
if [[ -z "$COUNT" || "$COUNT" -eq 0 ]]; then
  echo "Error: No files found in session"
  exit 1
fi

FIRST_FILE_PATH=$(echo "$FILES_RESPONSE" | jq -r '.files[0].path')
FILE_CONTENT_RESP=$(curl -s -H "Authorization: Bearer $TOKEN" "$API_BASE_URL/prototype/sessions/$SESSION_ID/files/$FIRST_FILE_PATH")
FILE_CONTENT=$(echo "$FILE_CONTENT_RESP" | jq -r '.content // empty')
if [[ -z "$FILE_CONTENT" ]]; then
  echo "Error: File content is empty for $FIRST_FILE_PATH"
  exit 1
fi

echo "Files and history validated: $COUNT files tracked, verified $FIRST_FILE_PATH"
echo "Smoke test passed successfully!"
exit 0
