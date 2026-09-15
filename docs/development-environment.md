# PP 2.0 — Development Environment & Reproducibility Guide

This document describes how to set up, bootstrap, and verify a clean local development environment for PP 2.0 from scratch.

---

## 1. Prerequisites

- **Docker Desktop** (running)
- **Node.js 20+** & **npm**
- **curl** and **jq**
- **git**

---

## 2. PostgreSQL via Docker

Run a local PostgreSQL 15 instance:

```bash
docker run -d \
  --name pp-postgres \
  -e POSTGRES_USER=pubprototype \
  -e POSTGRES_PASSWORD='<LOCAL_PASSWORD>' \
  -e POSTGRES_DB=pubprototype \
  -p 5432:5432 \
  postgres:15-alpine
```

Verify that PostgreSQL is ready:

```bash
docker exec pp-postgres pg_isready -U pubprototype -d pubprototype
```

Expected output:
```text
/var/run/postgresql:5432 - accepting connections
```

---

## 3. Database Migrations

Apply all schema migrations sequentially against the clean database:

```bash
for f in \
  db/migrations/001_initial_prototype_schema.sql \
  db/migrations/002_prototype_events.sql \
  db/migrations/003_prototype_promotions.sql \
  db/migrations/004_prototype_messages.sql \
  db/migrations/005_workspaces_projects_and_files.sql; do
  docker exec -i pp-postgres psql -U pubprototype -d pubprototype < "$f"
done
```

---

## 4. Local Environment Configuration (`.env`)

Configure `.env` for local standalone development:

```dotenv
DATABASE_URL="postgresql://pubprototype:<LOCAL_PASSWORD>@localhost:5432/pubprototype"
PP_API_PORT=3001
PP_WORKER_PORT=3002
PROTOTYPE_PREVIEW_MODE=local
AGENT_PROVIDER=mock
```

*(Never commit actual passwords or credentials to version control).*

---

## 5. Starting the Services

In separate terminal sessions or background processes:

### Start API Server
```bash
npm run dev
```
Listens on `http://localhost:3001` (health endpoint: `GET /health`).

### Start Dedicated Worker Daemon
```bash
npm run pp:worker
```
Listens on `http://localhost:3002` (health endpoint: `GET /ready`).

---

## 6. Deterministic Bootstrap

Run the bootstrap script to create a minimal operational hierarchy (workspace → project → prototype session):

```bash
./scripts/bootstrap-minimal.sh
```

- Verifies PostgreSQL, API, and worker readiness.
- Authenticates in dev mode (`POST /api/auth/login`).
- Creates a workspace (`POST /api/workspaces`).
- Creates a project (`POST /api/workspaces/:id/projects`).
- Creates a prototype session (`POST /prototype/sessions`).
- Records operational identifiers (non-sensitive metadata) into `scripts/bootstrap-output.json`.

---

## 7. Smoke Testing & Verification

Run the end-to-end smoke test to validate prompt execution and artifact creation:

```bash
./scripts/smoke-minimal.sh
```

The smoke script verifies:
1. **API & Worker Health**: Asserts both services respond healthy.
2. **Entity Consistency**: Confirms workspace, project, and session exist in PostgreSQL.
3. **Prompt Submission**: Submits a prompt via `POST /prototype/sessions/:id/prompts` and verifies HTTP 202 with valid `task.id`.
4. **Worker Execution**: Polls until session status transitions to `READY`.
5. **Database Checkpoints**: Verifies that `prototype_checkpoints` entries exist with commit SHA.
6. **Preview Serving**: Fetches live preview content via `previewUrl`.
7. **Files & History**: Asserts files list via `/prototype/sessions/:id/files` and inspects file content via `/prototype/sessions/:id/files/:path`.

---

## 8. Resetting State in DEV

To cleanly reset the local database without dropping the container:

```bash
docker exec pp-postgres psql -U pubprototype -d pubprototype \
  -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO pubprototype;"

for f in \
  db/migrations/001_initial_prototype_schema.sql \
  db/migrations/002_prototype_events.sql \
  db/migrations/003_prototype_promotions.sql \
  db/migrations/004_prototype_messages.sql \
  db/migrations/005_workspaces_projects_and_files.sql; do
  docker exec -i pp-postgres psql -U pubprototype -d pubprototype < "$f"
done
```
