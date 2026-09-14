# PP — REAL PRODUCT VERIFICATION LOOP

**Status:** Strategic North Star  
**Date:** 2026-09-14  
**Repository:** `pubcoreagencia/pub-prototype`

## 1. North Star

PP must be inspired by the Lovable experience: the user describes an idea in natural language and receives a working application quickly.

The critical differentiation is that PP must not stop at a visual prototype or mocked interaction.

> **Lovable creates what was requested. PP should only deliver what it can prove works.**

The target experience is:

```text
IDEA
  → PRODUCT UNDERSTANDING
  → FUNCTIONAL CONTRACT
  → FRONTEND + BACKEND + DATABASE
  → REAL RUNTIME
  → VERIFICATION
  → AUTOMATIC CORRECTION
  → RE-VERIFICATION
  → PROVEN PREVIEW
```

## 2. Product Principle

A preview is not considered ready merely because the application can render.

For PP:

> **Preview Ready = application executable + frontend/backend aligned + critical behavior verified + evidence recorded.**

Mocked data may exist for intentionally non-critical placeholder content, but mocks must never be used to falsely represent a functional backend, persistence layer, authentication flow, API integration, or core user action.

## 3. Current Architecture Baseline

The current PP already contains important foundations:

- conversational task execution;
- LLM/provider execution;
- isolated workspaces;
- Git branches and commits;
- PostgreSQL persistence;
- task lifecycle and leases;
- operational events/SSE;
- checkpoints and history;
- local/public preview runtimes;
- workspace snapshots and unexpected-change validation;
- task finalization;
- automatic correction attempts.

These capabilities should be preserved and composed into the verification loop rather than replaced.

## 4. Current Gaps Against the Target

### P0 — Functional Contract

The system needs a first-class representation of what the generated product must actually do.

A prompt such as:

> "Create a CRM with login, customers, pipeline and tasks."

should become verifiable requirements such as:

```text
Authentication
  - login
  - logout

Customers
  - create
  - list
  - update
  - delete

Persistence
  - data survives reload
  - data survives a new session

Integration
  - frontend → API
  - API → database
  - database → API
  - API → frontend
```

### P1 — Real Application Runtime

Frontend, backend and database must execute together whenever the requested product requires them.

The runtime must become the execution environment for verification, not merely a place to host a preview.

### P2 — Verification Engine

Verification must become a first-class subsystem and should cover, according to the product contract:

- build/type validation;
- unit/integration tests;
- API behavior;
- database behavior and persistence;
- frontend/backend integration;
- browser/E2E flows;
- critical UX states;
- console/request failures.

Browser automation, such as Playwright or an equivalent controlled browser runtime, is required for real end-to-end interaction verification.

### P3 — Autonomous Correction Loop

The existing correction loop is the foundation, but it must evolve from task-finalization correction into product-runtime correction.

Target:

```text
VERIFY
  ↓
FAILURE
  ↓
DIAGNOSE
  ↓
CORRECT
  ↓
REBUILD / RESTART
  ↓
RE-VERIFY
```

Correction should use concrete evidence from build, API, database and browser failures instead of only task-finalization errors.

### P4 — Proven Preview Gate

`PREVIEW_READY` must become downstream of successful verification.

Target lifecycle:

```text
BUILD_STARTED
  ↓
RUNTIME_READY
  ↓
VERIFICATION_STARTED
  ↓
VERIFICATION_PASSED
  ↓
DELIVERY_PROVEN
  ↓
PREVIEW_READY
```

Failure path:

```text
VERIFICATION_FAILED
  ↓
CORRECT
  ↓
REBUILD
  ↓
RE-VERIFY
```

## 5. Definition of Done

A product mutation must not be considered successfully delivered merely because the agent completed or files changed.

The default definition of done becomes:

```text
Code generated
+ frontend executable
+ backend executable
+ database configured when required
+ contracts/integration aligned
+ tests executed
+ critical E2E flows executed
+ failures corrected or explicitly escalated
+ verification evidence persisted
= PROVEN DELIVERY
```

## 6. Semantic Change to `COMPLETED`

The meaning of successful completion must evolve.

Current mental model:

> task finished.

Target mental model:

> **requested product behavior was implemented and verified.**

Conversational/non-mutating requests may remain exempt from product verification when they do not claim to modify or deliver application behavior.

## 7. Evidence-Based Delivery

Every proven delivery should produce structured evidence, for example:

```text
PRODUCT VERIFICATION REPORT

Build                 ✓
Frontend runtime      ✓
Backend runtime       ✓
Database              ✓
API flows             ✓
Persistence           ✓
Browser/E2E           ✓
Console errors        ✓
Network failures      ✓
Critical UX flows     ✓

Corrections: 2
E2E scenarios: 17/17

STATUS: PROVEN DELIVERY
```

The evidence becomes part of the product/session/checkpoint history and can later feed PUB Neural.

## 8. Strategic Architecture

```text
                         USER IDEA
                            ↓
                    PRODUCT PLANNER
                            ↓
                   FUNCTIONAL CONTRACT
                            ↓
             ┌──────────────┴──────────────┐
             ↓                             ↓
        FRONTEND ENGINE               BACKEND ENGINE
             ↓                             ↓
             └──────────────┬──────────────┘
                            ↓
                       REAL RUNTIME
                            ↓
                    VERIFICATION ENGINE
                            ↓
              ┌─────────────┼─────────────┐
              ↓             ↓             ↓
             API           DB          BROWSER
              └─────────────┼─────────────┘
                            ↓
                       PASS / FAIL
                       /          \
                     FAIL         PASS
                      ↓             ↓
                  CORRECT       EVIDENCE
                      ↓             ↓
                  REBUILD      PROVEN DELIVERY
                      ↓             ↓
                  RE-VERIFY   REAL PREVIEW
```

## 9. Product Positioning

PP should not try to become a clone of Lovable internally.

The surface experience should be Lovable-like:

> **Describe → generate → see → iterate.**

The internal differentiator should be:

> **Execute → verify → correct → prove.**

This is the core thesis of PP 2.0.

## 10. Implementation Priority

Do not prioritize additional peripheral UI/features before establishing the verification loop.

Recommended order:

1. Functional Contract model.
2. Real runtime orchestration for frontend/backend/database.
3. Mandatory verification gate for product mutations.
4. Browser/E2E verification.
5. Runtime-aware correction loop.
6. Verification evidence/report persistence.
7. Change `PREVIEW_READY` to require proven delivery.
8. Only then expand secondary product capabilities.

## 11. Success Metric

The key metric is not:

> "How fast can PP generate a prototype?"

It is:

> **"How fast can PP turn a natural-language idea into a real, verified, working application?"**

The ultimate target is:

```text
Natural language idea
        ↓
First preview
        ↓
Real frontend
        ↓
Real backend
        ↓
Real persistence
        ↓
Real user flows
        ↓
Verified
        ↓
Delivered
```

**PP should optimize for the shortest path from idea to proven software.**
