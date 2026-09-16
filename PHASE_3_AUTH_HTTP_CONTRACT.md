# PP SOVEREIGN AUTH · PHASE 3 HTTP AUTHENTICATION CONTRACT

**Document Date:** 2026-09-16  
**Status:** IMPLEMENTED & TESTED  
**Active Production Provider:** `supabase` (untouched)  
**Sovereign Provider Status:** OPERATIONAL IN PARALLEL  
**Golden E2E Verification:** PASS  
**Phase 3 Gate Result:** **`PP_SOVEREIGN_AUTH_PHASE_3 = PASS`**

---

## 1. Architectural Overview

Phase 3 delivers the complete HTTP authentication contract for PP Sovereign Auth. It exposes dedicated authentication endpoints directly under `/prototype/auth` while ensuring strict decoupling from `pubcore.site` and maintaining complete coexistence with the current production `supabase` provider.

```text
PP Client (Browser / API Consumer)
    │
    ├── POST /prototype/auth/signup      (Register user, hash password, issue initial tokens)
    ├── POST /prototype/auth/login       (Verify credentials, issue access token & refresh cookie)
    ├── POST /prototype/auth/refresh     (HttpOnly cookie -> CAS rotation -> new tokens)
    ├── POST /prototype/auth/logout      (Revoke session in DB, clear refresh cookie)
    ├── GET  /prototype/auth/me          (Validate Ed25519 token, fetch user profile & DB memberships)
    └── GET  /prototype/auth/.well-known/jwks.json (Public Ed25519 JWKS for asymmetric verification)
```

---

## 2. HTTP Endpoints Specification

### 2.1 POST `/prototype/auth/signup`
Creates a new sovereign user and issues an initial access token and HttpOnly refresh cookie.
- **Request Body:**
  ```json
  {
    "email": "developer@example.com",
    "password": "Min8CharPassword!",
    "name": "Alex Developer"
  }
  ```
- **Validation & Security:**
  - Email normalized to lowercase and validated against RFC-5322.
  - Password strength checked ($\ge 8$ characters, $\le 128$ characters).
  - Password hashed via cryptographic `scrypt` ($N=16384, r=8, p=1$, 16-byte salt, 64-byte key).
  - Duplicate account check returns uniform `409 {"error": "ACCOUNT_EXISTS"}` without enumeration details.
  - Plaintext password and password hash are **never** returned or logged.
- **Response `201 Created`:**
  ```json
  {
    "accessToken": "eyJhbGciOiJFZERTQSI...",
    "tokenType": "Bearer",
    "expiresIn": 900,
    "user": {
      "id": "c89b2b51-789a-4c12-b5e1-89a1c12d4567",
      "email": "developer@example.com",
      "name": "Alex Developer",
      "avatarUrl": null,
      "status": "ACTIVE",
      "createdAt": "2026-09-16T10:00:00.000Z",
      "updatedAt": "2026-09-16T10:00:00.000Z"
    }
  }
  ```
- **Set-Cookie Header:**
  ```http
  Set-Cookie: pp_refresh_token=rt_...; Path=/prototype/auth; HttpOnly; SameSite=Lax; Max-Age=2592000
  ```

---

### 2.2 POST `/prototype/auth/login`
Authenticates user credentials, creates a new session in `auth_sessions`, and issues fresh tokens.
- **Request Body:**
  ```json
  {
    "email": "developer@example.com",
    "password": "Min8CharPassword!"
  }
  ```
- **Security & Anti-Enumeration:**
  - If user is not found or password does not match, returns generic `401 {"error": "UNAUTHORIZED"}` with identical timing-resistant failure flow.
  - If account is `SUSPENDED` or inactive, returns `403 {"error": "ACCOUNT_INACTIVE"}`.
  - Refresh token is **never** returned in the JSON response body.
- **Response `200 OK`:**
  ```json
  {
    "accessToken": "eyJhbGciOiJFZERTQSI...",
    "tokenType": "Bearer",
    "expiresIn": 900,
    "user": { ... }
  }
  ```
- **Set-Cookie Header:**
  ```http
  Set-Cookie: pp_refresh_token=rt_...; Path=/prototype/auth; HttpOnly; SameSite=Lax; Max-Age=2592000
  ```

---

### 2.3 POST `/prototype/auth/refresh`
Rotates the session refresh token and emits a new access token and rotated refresh cookie.
- **Source of Token:** Exclusively from the `pp_refresh_token` HttpOnly cookie. Rejects request with `401 {"error": "UNAUTHORIZED"}` if cookie is absent.
- **Rotation Flow (Compare-And-Swap):**
  ```sql
  UPDATE auth_sessions
  SET revoked_at = NOW(), last_active_at = NOW()
  WHERE id = $1 AND revoked_at IS NULL
  RETURNING id, family_id, user_id;
  ```
- **Theft / Reuse Detection:** If an already revoked or rotated refresh token is presented, the system triggers family invalidation:
  ```sql
  UPDATE auth_sessions
  SET revoked_at = NOW()
  WHERE family_id = $1 AND revoked_at IS NULL;
  ```
  Returns `401 {"error": "REUSE_DETECTED"}` and clears the cookie.
- **Response `200 OK`:**
  ```json
  {
    "accessToken": "eyJhbGciOiJFZERTQSI...",
    "tokenType": "Bearer",
    "expiresIn": 900
  }
  ```

---

### 2.4 POST `/prototype/auth/logout`
Revokes the session in PostgreSQL and clears the refresh cookie.
- **Behavior:**
  - Hashes the presented `pp_refresh_token` and revokes the corresponding row in `auth_sessions`.
  - Clears `pp_refresh_token` cookie (`Max-Age=0`).
  - Completely idempotent: returns `200 {"ok": true}` even if the cookie is missing or already expired.
- **Token Invalidation Scope:**
  - Refresh session is terminated immediately in database.
  - Short-lived asymmetric JWT (15-min TTL) remains valid in client memory until its natural expiration.

---

### 2.5 GET `/prototype/auth/me`
Fetches the active user profile and dynamic database-driven workspace memberships.
- **Authentication:** `Authorization: Bearer <sovereign_access_token>`.
- **Database Truth:** RBAC permissions are not trusted from client claims; they are dynamically queried from `workspace_members` joining `workspaces`.
- **Response `200 OK`:**
  ```json
  {
    "user": {
      "id": "c89b2b51-789a-4c12-b5e1-89a1c12d4567",
      "email": "developer@example.com",
      "name": "Alex Developer",
      "avatarUrl": null,
      "status": "ACTIVE",
      "createdAt": "2026-09-16T10:00:00.000Z",
      "updatedAt": "2026-09-16T10:00:00.000Z"
    },
    "workspaces": [
      {
        "id": "11111111-1111-1111-1111-111111111111",
        "name": "Default Workspace",
        "slug": "default-workspace",
        "role": "OWNER"
      }
    ]
  }
  ```

---

### 2.6 GET `/prototype/auth/.well-known/jwks.json`
Exposes the public key set for stateless verification by edge services, gateways, or downstream runtimes.
- **Response `200 OK`:**
  ```json
  {
    "keys": [
      {
        "kty": "OKP",
        "crv": "Ed25519",
        "x": "...",
        "kid": "pp-key-...",
        "use": "sig",
        "alg": "EdDSA"
      }
    ]
  }
  ```
- **Caching:** `Cache-Control: public, max-age=3600, stale-while-revalidate=86400`.
- **Security Invariant:** Private key (`d`) is omitted from JWKS output.

---

## 3. Security Boundary, Cookies, CSRF, & CORS

1. **Cookie Configuration:**
   - Name: `pp_refresh_token`
   - Attributes: `HttpOnly; SameSite=Lax; Path=/prototype/auth; Secure` (in production).
   - Max-Age: 30 days (`2592000` seconds).
2. **CSRF Strategy:**
   - Mutating auth endpoints (`/refresh`, `/logout`, `/login`, `/signup`) accept only `POST` requests with `Content-Type: application/json`.
   - Browser cross-site `GET` navigation cannot trigger refresh or logout.
   - `SameSite=Lax` ensures cookies are not attached on cross-site subresource requests.
3. **CORS Isolation:**
   - Origins restricted to explicit PP allowlist (`https://pubcore.site`, `http://localhost:3000`, `http://localhost:3001`, `http://localhost:5173`).
   - Wildcard `*` with credentials is explicitly prohibited.
   - `Access-Control-Allow-Credentials: true` is only sent when the incoming origin matches the allowlist.
4. **Rate Limiting:**
   - `POST /prototype/auth/login`: 5 attempts per minute per IP.
   - `POST /prototype/auth/signup`: 10 accounts per hour per IP.
   - `POST /prototype/auth/refresh`: 30 rotations per minute per IP.
5. **No Cache:**
   - All auth endpoints return `Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate`.

---

## 4. Error Contract

All error responses strictly follow a uniform machine-readable JSON schema:

| Status Code | Error Code | Scenario |
| :--- | :--- | :--- |
| `400 Bad Request` | `{"error": "INVALID_REQUEST"}` | Malformed email, password length $< 8$, missing required body fields |
| `401 Unauthorized` | `{"error": "UNAUTHORIZED"}` | Wrong password, user not found, missing/expired token or cookie |
| `401 Unauthorized` | `{"error": "REUSE_DETECTED"}` | Attempted reuse of an already rotated refresh token |
| `403 Forbidden` | `{"error": "ACCOUNT_INACTIVE"}` | User status is `SUSPENDED` or non-active |
| `409 Conflict` | `{"error": "ACCOUNT_EXISTS"}` | Email already registered |
| `429 Too Many Requests` | `{"error": "RATE_LIMITED"}` | Rate limit window exceeded |
| `500 Internal Error` | `{"error": "INTERNAL_ERROR"}` | Unhandled server error (stack trace sanitized and hidden) |

---

## 5. Production Coexistence & Factory Pattern

The provider abstraction is cleanly centralized in [`src/pp/auth/factory.ts`](file:///Users/user/Documents/antigravity/pub%20prototype/src/pp/auth/factory.ts):
```typescript
export function getAuthProvider(options: AuthFactoryOptions): AuthProvider {
  const provider = (options.providerName ?? process.env.AUTH_PROVIDER ?? 'supabase').toLowerCase();
  if (provider === 'sovereign') {
    return new SovereignAuthProvider(options.pool, options.keyManager);
  }
  return new SupabaseAuthProvider();
}
```
- In production, `AUTH_PROVIDER` remains unset or `supabase`.
- The existing `/api/auth/*` endpoints remain operational for existing Supabase clients.
- The new `/prototype/auth/*` endpoints provide the Sovereign HTTP contract.

---

## 6. Verification Summary

All test suites pass cleanly:
- `tests/pp-sovereign-http-auth.test.ts`: **16/16 PASS**
- `tests/pp-sovereign-security-and-tenancy.test.ts`: **4/4 PASS**
- `tests/pp-sovereign-rate-limit.test.ts`: **1/1 PASS**
- `tests/pp-sovereign-auth.test.ts`: **19/19 PASS**
- `tests/pp-refresh-concurrency.test.ts`: **1/1 PASS**
- `tests/pp-auth-session-recovery.test.ts`: **8/8 PASS**
- `tests/pp-auth-and-multi-tenancy.test.ts`: **6/6 PASS**
- `tests/prototype-concurrency-migrations.test.ts`: **3/3 PASS**
- TypeScript Typecheck (`tsc --noEmit`): **0 ERRORS**
- Production Build (`npm run build`): **0 ERRORS**
