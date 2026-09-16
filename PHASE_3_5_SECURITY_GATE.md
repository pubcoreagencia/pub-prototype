# PP · PHASE 3.5 SECURITY GATE
## Sovereign Auth Production Readiness Audit Report

**Audit Date:** 2026-09-16  
**Commit Inspected:** `893b133`  
**Provider Active in Production:** `supabase` (untouched)  
**Sovereign Provider Status:** Implemented & Isolated in parallel (`/prototype/auth/*`)  
**Golden E2E Verification:** PASS  
**Final Evaluation:** **`PP_SOVEREIGN_AUTH_PHASE_3_5 = PASS_WITH_CONDITIONS`**

---

## 1. Executive Summary

The Phase 3.5 Security Gate evaluated the production-readiness of the newly completed Sovereign Authentication HTTP contract across 12 strict technical gates. The system achieves complete cryptographic sovereignty, atomic session rotation with linearizable Compare-And-Swap (CAS), strict asymmetric Ed25519 token enforcement, and robust anti-enumeration protections.

The evaluation status is **`PASS_WITH_CONDITIONS`** because while the cryptographic and endpoint contracts are fully hardened, three architectural prerequisites must be addressed before conducting a production cutover (`AUTH_PROVIDER=sovereign`):
1. **CSRF Explicit Origin Enforcement:** While `SameSite=Lax` and CORS protect browser contexts, an explicit `Origin`/`Referer` header validation check should be added directly inside mutating auth endpoints for non-browser/cross-origin defensive depth.
2. **Private Key Secret Provisioning:** `KeyManager` currently generates in-memory ephemeral keys unless provisioned via `PP_AUTH_PRIVATE_KEY_PEM`. Railway deployment environment must be injected with the static private key secret before cutover.
3. **Workspace Provisioning on First Login/Signup:** A sovereign user who signs up receives an active identity in `users`, but does not automatically own a workspace. The project creation and workspace provisioning flow in Phase 4 must either automatically create a default personal workspace on signup or guide the user through workspace initialization.

---

## 2. Gate-by-Gate Evaluation Matrix

| Gate | Focus Area | Technical Assessment | Status |
| :--- | :--- | :--- | :--- |
| **Gate 1** | CSRF Defense | `SameSite=Lax` + `Content-Type: application/json` + CORS allowlist. Explicit Origin validation recommended for Phase 4. | **PASS (Condition 1)** |
| **Gate 2** | CORS & Project Isolation | Sovereign PP allowlist (`pubcore.site`, localhost). Wildcard credentials strictly blocked. `pubcore.site` is only a consumer, not operational authority. | **PASS** |
| **Gate 3** | Rate Limiting | 5 req/min (login), 10 req/hr (signup), 30 req/min (refresh). Single-instance memory store. | **PASS (Known limitation)** |
| **Gate 4** | Signup $\to$ Workspace Isolation | Zero leakage. New users have no default access to existing workspaces. RBAC strictly database-driven via `workspace_members`. | **PASS (Condition 2)** |
| **Gate 5** | JWT Cryptographic Rigor | Ed25519 / EdDSA enforced. `alg:none`, `HS256`, mismatched `kid`, expired tokens, and payload tampering strictly rejected. | **PASS** |
| **Gate 6** | Session Revocation | DB session revoked immediately upon logout; 15-min access token expires statelessly via TTL. | **PASS** |
| **Gate 7** | Refresh Concurrency | Atomic CAS (`WHERE revoked_at IS NULL`) verified under real concurrency; replay triggers immediate family invalidation (`REUSE_DETECTED`). | **PASS** |
| **Gate 8** | Private Key Persistence | Asymmetric Ed25519 keys; private key omitted from JWKS, Git, logs, and frontend. Persisted key injection ready for Railway. | **PASS (Condition 3)** |
| **Gate 9** | Password Security | `scrypt` ($N=16384, r=8, p=1$, 16B salt, 64B key), timing-safe comparison, `needsRehash()` agility, hash never exposed in API. | **PASS** |
| **Gate 10**| Legacy Auth Isolation | Supabase provider isolated behind `AuthProvider` interface & `src/pp/auth/factory.ts`. No leaked dependencies. | **PASS** |
| **Gate 11**| PP Independence | Full platform stack (API, Worker, DB, Auth, Preview, Recovery) verified capable of 100% sovereign operation. | **PASS** |
| **Gate 12**| No Cutover Rule | Zero cutover executed; `AUTH_PROVIDER = supabase` remains active in production; `pubcore` untouched. | **PASS** |

---

## 3. Deep-Dive Gate Results

### Gate 1 · CSRF & Origin Validation
- **Current Defenses:**
  1. `pp_refresh_token` cookie uses `SameSite=Lax; HttpOnly; Path=/prototype/auth`. Cross-site `GET` requests (e.g. `<img>`, `<a>`) cannot execute mutations.
  2. Mutating endpoints (`/refresh`, `/logout`, `/login`, `/signup`) accept only `POST`.
  3. Express CORS middleware intercepts preflight `OPTIONS` and cross-origin requests, denying `Access-Control-Allow-Origin` to unapproved origins.
- **Tested Scenario:** `Origin: https://evil.example` preflight rejected with `403 Forbidden` (`tests/pp-phase3-5-security-gate.test.ts`).
- **Condition for Phase 4:** Add explicit `Origin` validation middleware to `/prototype/auth/refresh` and `/prototype/auth/logout` that rejects requests if the `Origin` header is present and does not match the PP authorized origins.

### Gate 2 · CORS & Project Isolation Matrix
Inspected all references across `src/`, `entry.ts`, `ui/`, `auth/`, and configuration:

| Allowed Origin / Dependency | Nature | Classification | Operational Authority? |
| :--- | :--- | :--- | :--- |
| `https://pubcore.site` | Host Consumer | `EXPLICIT_EXTERNAL_INTEGRATION` | **NO** (Client only) |
| `http://localhost:3000` | Local Web Dev | `PP_INTERNAL` | **NO** |
| `http://localhost:3001` | Local API Dev | `PP_INTERNAL` | **NO** |
| `http://localhost:5173` | Local Vite Dev | `PP_INTERNAL` | **NO** |
| `api.pubcore.site` | Default JWT `iss` | `LEGACY_DEFAULT` | Configurable via `PP_AUTH_ISSUER` |
| `pub-prototype:token` | Frontend localStorage | `TRANSITIONAL` | Used by existing PP UI client |

**Conclusion:** `pubcore.site` is strictly an external integration consumer. It possesses zero operational authority over PP Sovereign Auth.

### Gate 3 · Rate Limiting Audit
- **Implementation:** `express-rate-limit` using `MemoryStore`.
  - `/prototype/auth/login`: 5 requests / 60 seconds per IP (`tests/pp-sovereign-rate-limit.test.ts` verified 429 activation).
  - `/prototype/auth/signup`: 10 requests / 1 hour per IP.
  - `/prototype/auth/refresh`: 30 requests / 60 seconds per IP.
- **Proxy Configuration:** `app.set('trust proxy', 1)` is configured in `src/pp/api/entry.ts`, allowing accurate client IP detection behind Railway's reverse proxy.
- **Known Limitation:** `KNOWN LIMITATION: SINGLE-INSTANCE RATE LIMIT STORE`. In-memory tracking resets on process restart and does not synchronize across multiple concurrent Railway replicas. Acceptable for current single-replica deployment; Redis store recommended for horizontal scaling.

### Gate 4 · Signup $\to$ Workspace Isolation
- When a user signs up via `POST /prototype/auth/signup`, a record is inserted into `users` with `status = 'ACTIVE'`.
- The system **does not** automatically associate the user with existing workspaces (`workspaces` or `workspace_members`).
- `GET /prototype/auth/me` returns `workspaces: []`.
- User A cannot view or manipulate resources of User B. Multi-tenancy enforcement in `AuthService.authorizeWorkspace()` and `AuthService.authorizeSession()` denies access (`403 Forbidden`) unless an explicit row exists in `workspace_members`.
- **Condition for Phase 4:** UI onboarding must provide a "Create Workspace" or "Invite to Workspace" flow upon initial login.

### Gate 5 · JWT Security Audit
- Verified in `tests/pp-phase3-5-security-gate.test.ts`:
  - `alg: none` attack: **REJECTED** (`Unsupported algorithm: none`).
  - `HS256` HMAC confusion attack: **REJECTED** (`Unsupported algorithm: HS256`).
  - Unknown `kid`: **REJECTED** (`Unknown key identifier`).
  - Expired token ($>900\text{s}$): **REJECTED** (`Token has expired`).
  - Payload tampering: **REJECTED** (`Invalid cryptographic signature`).
  - Claims: Token contains only `iss`, `sub`, `aud`, `sid`, `iat`, `exp`, `jti`. Role and password hashes are completely absent.

### Gate 6 · Session Revocation Semantics
- Refresh sessions are backed by PostgreSQL `auth_sessions`.
- Upon `POST /prototype/auth/logout`, `auth_sessions.revoked_at` is set to `now()`, immediately preventing any subsequent refresh rotation.
- Access tokens (Ed25519 JWT) have a maximum lifetime of 15 minutes and are verified statelessly. Documented: stateless tokens remain cryptographically valid until expiration.

### Gate 7 · Refresh Rotation Concurrency
- Refresh rotation utilizes atomic Compare-And-Swap (CAS):
  ```sql
  UPDATE auth_sessions SET revoked_at = now(), last_active_at = now() 
  WHERE id = $1 AND revoked_at IS NULL;
  ```
- If 5 concurrent requests present the same refresh token, exactly 1 wins; the other 4 observe `rowCount === 0` and immediately trigger `REUSE_DETECTED`, invalidating the entire `family_id` to prevent token replay attacks.

### Gate 8 · Private Key Persistence Architecture
- Public keys are exposed via `GET /prototype/auth/.well-known/jwks.json` (`kty: OKP`, `crv: Ed25519`, `alg: EdDSA`).
- Private key parameters (`d`) are strictly omitted from JWKS, logging, and responses.
- **Condition for Cutover:** KeyManager must be booted with static `PP_AUTH_PRIVATE_KEY_PEM` in production environment variables so Railway restarts do not invalidate active JWTs.

### Gate 9 · Password Security
- Algorithm: `scrypt` with $N = 16384$, $r = 8$, $p = 1$, 16-byte random salt, 64-byte key length.
- Verification: Constant-time buffer comparison via `crypto.timingSafeEqual`.
- Agility: `needsRehash(storedHash)` function exists for parameter upgrades.
- Anti-leak: `password_hash` is stripped from all API outputs.

---

## 4. Legacy Dependency & Component Independence Matrix

### 4.1 Dependency Classification Matrix

| Component / Setting | Nature | Required Today? | Classification |
| :--- | :--- | :--- | :--- |
| `SUPABASE_URL` | Supabase Auth API URL | YES (Production) | `LEGACY_REQUIRED_FOR_CURRENT_PRODUCTION` |
| `SUPABASE_ANON_KEY` | Supabase Client Key | YES (Production) | `LEGACY_REQUIRED_FOR_CURRENT_PRODUCTION` |
| `src/pp/auth/supabase-provider.ts` | Provider Adapter | YES (Production) | `LEGACY_REQUIRED_FOR_CURRENT_PRODUCTION` |
| `/api/auth/*` | Legacy Endpoints | YES (Production) | `LEGACY_REQUIRED_FOR_CURRENT_PRODUCTION` |
| `src/pp/auth/http.ts` | Sovereign HTTP Router | NO (Tested parallel) | `SOVEREIGN_PATH` |
| `src/pp/auth/sovereign-provider.ts`| Sovereign Provider | NO (Tested parallel) | `SOVEREIGN_PATH` |
| `pubcore.site` (CORS allowlist) | Host App Client | OPTIONAL | `EXPLICIT_EXTERNAL_INTEGRATION` |
| `pub-prototype:token` | Frontend Storage Key | YES (Current UI) | `TRANSITIONAL` |

### 4.2 PP Independence Matrix (Simulating Outages)

If `pubcore.site` and `Supabase` are completely unreachable:

| Subsystem | Status Under Sovereign Auth | Notes |
| :--- | :--- | :--- |
| **PP API** | **WORKS** | Dedicated Express service running on Railway |
| **PP DB** | **WORKS** | Dedicated PostgreSQL running on Railway |
| **PP Worker** | **WORKS** | Dedicated prototype worker processing tasks |
| **PP Sovereign Auth**| **WORKS** | Local DB sessions, scrypt hashing, Ed25519 JWT |
| **PP Preview** | **WORKS** | Native preview served directly from PP API |
| **PP Recovery Loop**| **WORKS** | Verification gate & correction controller |
| **pubcore.site** | **OPTIONAL** | Host can be embedded or completely bypassed |
| **Supabase** | **OPTIONAL** | Fully replaceable by `AUTH_PROVIDER=sovereign` |

---

## 5. Blockers vs. Non-Blockers

### Blockers for Phase 4
- **NONE.** The HTTP authentication contract is fully established, tested, and ready for Phase 4 UI and onboarding design.

### Non-Blockers / Conditions for Future Phase 5 Cutover
1. **Explicit Origin Header Validation:** Add explicit check on mutating endpoints (`/refresh`, `/logout`).
2. **KMS / Secret Bootstrapping:** Supply `PP_AUTH_PRIVATE_KEY_PEM` via Railway environment variables.
3. **Workspace Onboarding:** Design UI onboarding in Phase 4 to create initial workspace for self-registered users.
4. **Rate Limit Distributed Store:** Migrate from memory store to Redis if scaling PP API to multiple replicas.

---

## 6. Recommendations for Phase 4

1. **UI Login & Signup Views:** Implement sovereign login and signup forms within the PP frontend (`/prototype/login`, `/prototype/signup`).
2. **Cookie Handling:** Ensure web frontend uses `credentials: 'include'` on all `/prototype/auth/*` requests so `pp_refresh_token` is seamlessly handled by the browser.
3. **Token Memory Storage:** Store short-lived access token in client memory (or state manager), refreshing automatically via `POST /prototype/auth/refresh` on 401 or timer.
4. **Preserve Legacy Fallback:** Continue to support `localStorage.getItem('pub-prototype:token')` until final cutover.

---

## 7. Automated Test Evidence

- `tests/pp-phase3-5-security-gate.test.ts`: **8/8 PASS**
- `tests/pp-sovereign-http-auth.test.ts`: **16/16 PASS**
- `tests/pp-sovereign-security-and-tenancy.test.ts`: **4/4 PASS**
- `tests/pp-sovereign-rate-limit.test.ts`: **1/1 PASS**
- `tests/pp-sovereign-auth.test.ts`: **19/19 PASS**
- `tests/pp-refresh-concurrency.test.ts`: **1/1 PASS**
- `tests/pp-auth-session-recovery.test.ts`: **8/8 PASS**
- `tests/pp-auth-and-multi-tenancy.test.ts`: **6/6 PASS**
- `tests/prototype-concurrency-migrations.test.ts`: **3/3 PASS**
- Total Active Suite: **66/66 PASS**
- Typecheck (`npm run typecheck`): **0 errors**
- Build (`npm run build`): **0 errors**
