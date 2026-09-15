#!/usr/bin/env bash
set -euo pipefail

# Abort if running in production
if [[ "${NODE_ENV:-}" == "production" ]]; then
  echo "Abort: production environment detected"
  exit 1
fi

# Verify required tools
for cmd in curl jq npm; do
  if ! command -v $cmd >/dev/null 2>&1; then
    echo "Error: $cmd is required but not installed"
    exit 1
  fi
done

# Check PostgreSQL readiness
if ! docker exec pp-postgres pg_isready -U pubprototype -d pubprototype -q; then
  echo "PostgreSQL is not ready"
  exit 1
fi

# API health check
API_PORT="${PP_API_PORT:-3001}"
if ! curl -sSf http://localhost:$API_PORT/health >/dev/null; then
  echo "API health check failed"
  exit 1
fi

# Authenticate (dev mode returns test-token)
AUTH_RESPONSE=$(curl -s -X POST http://localhost:$API_PORT/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"dev","password":"dev"}')
TOKEN=$(echo "$AUTH_RESPONSE" | jq -r '.token // "test-token"')
if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
  echo "Failed to obtain auth token"
  exit 1
fi

post_json() {
  local url=$1
  local json=$2
  curl -s -X POST "$url" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$json"
}

# Create workspace
WS_RESPONSE=$(post_json http://localhost:$API_PORT/api/workspaces '{"name":"bootstrap-ws","slug":"bootstrap-ws"}')
WORKSPACE_ID=$(echo "$WS_RESPONSE" | jq -r '.id')
if [[ -z "$WORKSPACE_ID" || "$WORKSPACE_ID" == "null" ]]; then
  echo "Failed to create workspace"
  exit 1
fi

# Create project within workspace
PROJ_RESPONSE=$(post_json http://localhost:$API_PORT/api/workspaces/$WORKSPACE_ID/projects '{"name":"bootstrap-proj"}')
PROJECT_ID=$(echo "$PROJ_RESPONSE" | jq -r '.id')
if [[ -z "$PROJECT_ID" || "$PROJECT_ID" == "null" ]]; then
  echo "Failed to create project"
  exit 1
fi

# Create prototype session
SESSION_RESPONSE=$(post_json http://localhost:$API_PORT/prototype/sessions "{\"project\": \"bootstrap-proj\", \"projectId\": \"$PROJECT_ID\"}")
SESSION_ID=$(echo "$SESSION_RESPONSE" | jq -r '.id')
if [[ -z "$SESSION_ID" || "$SESSION_ID" == "null" ]]; then
  echo "Failed to create prototype session"
  exit 1
fi

# Write output JSON
OUTPUT_FILE="scripts/bootstrap-output.json"
cat > "$OUTPUT_FILE" <<EOF
{
  "apiBaseUrl": "http://localhost:$API_PORT",
  "workspaceId": "$WORKSPACE_ID",
  "projectId": "$PROJECT_ID",
  "sessionId": "$SESSION_ID",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

echo "Bootstrap completed. Details written to $OUTPUT_FILE"
