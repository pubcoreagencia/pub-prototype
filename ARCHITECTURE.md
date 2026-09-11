# PUB PROTOTYPE (PP) — ARCHITECTURE GUIDE

## 1. System Mission & Scope
The **PUB Prototype** system provides rapid iteration, live multi-file previews, and conversational evolution of web and backend prototypes. It serves as the rapid-prototyping precursor to the formal engineering workflow of **PUB Dev Loop (PDL)**.

---

## 2. High-Level Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                      Client Browser                         │
│       (Interactive Workbench UI & Live Preview Iframe)      │
└──────────────────────────────▲──────────────────────────────┘
                               │ HTTP / SSE
┌──────────────────────────────▼──────────────────────────────┐
│                    Standalone PP API Server                 │
│                   (src/pp/api/entry.ts)                     │
│                                                             │
│   • Session Management      • Checkpoint Rollback           │
│   • Multi-turn Prompts      • Live SSE Event Stream         │
│   • Promotion Endpoint      • Dynamic Preview Proxy         │
└──────────────┬───────────────────────────────▲──────────────┘
               │ Postgres Claim / Enqueue      │
┌──────────────▼───────────────────────────────┴──────────────┐
│                  Standalone PP Worker Daemon                │
│                  (src/pp/worker/entry.ts)                   │
│                                                             │
│   • Prototype Worker Daemon • Tool Dispatch & Sandboxing    │
│   • LLM Execution Loop      • Checkpoint Generation         │
│   • Correction Controller   • Static/Node Preview Host      │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
            ┌────────────────────────────────────┐
            │       Sovereign PP Database        │
            │    (PostgreSQL - db/migrations)    │
            │                                    │
            │  • prototype_sessions              │
            │  • prototype_tasks                 │
            │  • prototype_checkpoints           │
            │  • prototype_events                │
            │  • prototype_promotions            │
            │  • prototype_messages              │
            └────────────────────────────────────┘
```

---

## 3. Subsystem Breakdown

### 3.1 API Server (`src/pp/api/`)
- Express-based HTTP service offering REST endpoints and Server-Sent Events (SSE).
- Handles user prompts, generates initial prototypes, queries session status, restores checkpoints, and initiates promotion to PDL.
- Proxies requests to live preview sandboxes.

### 3.2 Worker Daemon (`src/pp/worker/`)
- Polls `prototype_tasks` for unassigned work using atomic `claim()` mechanics (`FOR UPDATE SKIP LOCKED`).
- Orchestrates multi-step code generation, tool invocations, and workspace management.
- Captures workspace state and registers checkpoints in `prototype_checkpoints`.

### 3.3 Preview Infrastructure (`src/pp/preview/`)
- **Static Preview**: Serves HTML/JS/CSS assets directly from isolated workspace directories.
- **Node.js Preview Runtime**: Spawns isolated Node processes, binds to dedicated localhost ports, performs health checks, and lifecycle-manages child processes.

### 3.4 Promotion / Handoff (`src/pp/handoff/`)
- When a prototype reaches production readiness, the user initiates a promotion via `POST /prototype/sessions/:id/promote`.
- PP captures the checkpoint snapshot, creates a promotion record in `prototype_promotions`, and dispatches the payload across the decoupled `PdlTaskIngestionPort` boundary.
- **Transport**: `HttpPdlTaskIngestionPort` dispatches over HTTP `POST /tasks/ingest` to PDL API.
- **Request Contract (`PdlTaskIngestionRequest`)**:
  - `project`, `repository`, `branch`, `checkpointSha`, `promotionId`, `prototypeSessionId`, `objective`, `prompt`, `priority` (optional).
- **Result Contract (`PdlTaskIngestionResult`)**:
  - `id`, `taskId`, `status`, `branch`, `repository`, `prototypeSessionId`, `result`.
- **Ownership & Correlation**:
  - PP owns: `promotionId`, `prototypeSessionId`, `checkpointSha`.
  - PDL owns: `pdlTaskId` (`id`/`taskId`), `status`, `ExecutionSpec`.
  - Zero shared database foreign keys.
- **Idempotency & Failure Semantics**:
  - Same `promotionId` guarantees exact same PDL task is returned without duplicate task creation.
  - Failures on HTTP 4xx (validation/malformed) fail closed immediately; network errors/timeouts raise `PDL_HANDOFF_TIMEOUT` / `PDL_HANDOFF_FAILED`.

---

## 4. Database Schema

All database migrations reside in `db/migrations/` and use sequential 3-digit prefixes:

1. `001_initial_prototype_schema.sql`:
   - `prototype_sessions`: Primary lifecycle entity holding workspace path, status, and metadata.
   - `prototype_tasks`: Dedicated task queue for worker execution iterations.
   - `prototype_checkpoints`: Immutable historical snapshots of generated prototype code.
2. `002_prototype_events.sql`:
   - `prototype_events`: Structured event log supporting optimistic idempotency and SSE streaming.
3. `003_prototype_promotions.sql`:
   - `prototype_promotions`: Audit log of promotion handoffs to PDL.
4. `004_prototype_messages.sql`:
   - `prototype_messages`: Chat/prompt turn history linked directly to `prototype_tasks(id)`.

---

## 5. Clean Boundary Guarantees
- Zero physical foreign keys to tables outside the prototype schema.
- Zero compile-time or runtime imports from `src/pdl/**`.
- Autonomous test suite runnable with in-memory or dedicated Postgres instances.
- Untrusted product intent handed over through neutral boundary contract; PDL enforces engineering execution authority and trust boundaries.
