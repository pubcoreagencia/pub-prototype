# PUB PROTOTYPE — EXTRACTION PROVENANCE

## Overview
This document records the provenance and extraction metadata for the standalone **PUB Prototype (PP)** repository.

---

## Provenance Metadata

- **Source Repository**: `PUB DEV LOOP` (`pubcoreagencia/pub-dev-loop`)
- **Source Baseline Commit**: `cdcff749a03e670ecbbfdb4ff918732e718bf14f` (Phase 3D Freeze Commit)
- **Extraction Phase**: Phase 3D — Step 8 (Physical PP Repository Extraction)
- **Date of Extraction**: 2026-09-11
- **Target Repository**: `pubcoreagencia/pub-prototype`
- **Target Remote Origin**: `https://github.com/pubcoreagencia/pub-prototype.git`
- **Default Branch**: `main`

---

## Extracted Subsystem Modules

All prototype-owned components were transferred from `src/pp/**` in the monorepo into the sovereign repository:

1. **API Subsystem (`src/pp/api/`)**:
   - HTTP routes and middleware for sessions, prompts, previews, checkpoints, promotion, and event streaming (SSE).
   - Dedicated standalone entrypoint: `src/pp/api/entry.ts`.
2. **Worker Subsystem (`src/pp/worker/`)**:
   - Autonomous background prototype worker daemon, job claiming, execution loop, and workspace isolation.
   - Dedicated standalone entrypoint: `src/pp/worker/entry.ts`.
3. **Domain Core (`src/pp/domain/`)**:
   - State machine, session lifecycle, model routing, event schemas, prompt formatting, and correction controller.
4. **Persistence Layer (`src/pp/persistence/`)**:
   - Autonomous PostgreSQL repositories for sessions, checkpoints, events, messages, promotions, and tasks (`prototype_tasks`).
5. **Preview Infrastructure (`src/pp/preview/`)**:
   - Preview orchestrator, static artifact server, and dynamic Node.js runtime process manager with container-ready port allocations.
6. **UI Componentry (`src/pp/ui/`)**:
   - Integrated client-side workbench UI assets and templates.
7. **Handoff Contracts (`src/pp/handoff/`)**:
   - Decoupled ingestion port interfaces and adapters (`InMemoryPdlTaskIngestionPort`, `HttpPdlTaskIngestionPort`) ensuring zero compile-time dependencies on PDL internal code.

---

## Vendored Shared Dependencies

To achieve complete autonomous compilation and runtime operation without cyclic dependencies on the PDL execution core, neutral shared utility layers were vendored into root `src/`:

- `src/domain.ts`: Neutral data interfaces (`Task`, `AttemptTrace`, `WorkerExecutionTrace`).
- `src/worker.ts`: Git credential and identity configuration helpers.
- `src/agent.ts`: Standalone provider factory and mock providers.
- `src/finalizer.ts`: Workspace snapshot capture, finalization, and validation.
- `src/tools/`: Tool execution security, runtime wrappers, and types.
- `src/providers/`: LLM provider integrations (OpenRouter, Anthropic, Gemini, OpenAI, Groq, Ollama).
- `src/routing/`: Model selection, cost calibration, observability, and routing fallbacks.
- `src/executor.ts`: Unified prompt executor and tool dispatch loop.
- `src/api-error-classifier.ts`: Resilient classification of provider and network failures.
- `src/github-app.ts`: Token helper and repository whitelisting.

---

## Database Boundary & Migration Decoupling

The standalone database migrations (`db/migrations/`) are fully self-sufficient and contain ZERO cross-database foreign keys:

- `001_initial_prototype_schema.sql`:
  - `prototype_sessions`
  - `prototype_tasks` (independent sovereign task queue for prototype iterations)
  - `prototype_checkpoints`
- `002_prototype_events.sql`:
  - `prototype_events`
- `003_prototype_promotions.sql`:
  - `prototype_promotions` (with correlation ID reference to external PDL tasks)
- `004_prototype_messages.sql`:
  - `prototype_messages` (with `task_id REFERENCES prototype_tasks(id) ON DELETE SET NULL`)

---

## Verification Summary

- **TypeScript Compilation**: `npm run typecheck` — 0 errors.
- **Production Build**: `npm run build` — 0 errors, clean `dist/` bundle.
- **Unit & Integration Tests**: `npm test` — 25 suites, 161/161 tests passing.
- **Module Bootstrapping**: `createPpApp()` and `createPrototypeWorkerDaemon()` boot cleanly in isolation.
- **PDL Source Integrity**: The source PDL repository remained completely untouched during Step 8.
