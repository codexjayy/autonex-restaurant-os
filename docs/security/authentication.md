# Authentication, Session Rotation & CSRF Security

Implemented across `packages/auth` (`@autonex/auth`) and `apps/api/src/modules/auth`.

## 1. Password & Staff PIN Hashing (Argon2id + Safe Migration)

- New passwords and staff PINs are hashed with `@node-rs/argon2` using OWASP-recommended **Argon2id** (`algorithm: 2`, `memoryCost: 19456`, `timeCost: 2`, `parallelism: 1`, `outputLen: 32`) producing standard `$argon2id$` PHC strings.
- `verifySecret()` in `@autonex/auth` transparently verifies legacy `scrypt:` hashes during login; `needsRehash()` upgrades verified legacy hashes to Argon2id on login without forcing password resets.
- Staff outlet PIN logins lock after 5 consecutive failures (`failedAttempts`, `lockedUntil` = 15 minutes).

## 2. JWT Access Tokens & Rotating Refresh Families

- **Access Token**: Short-lived signed JWT (`JWT_ACCESS_SECRET`, default `15m`) carrying `sub`, `tenantId`, `outletId`, `membershipId`, `role`, `isSuperAdmin`, and `tenantStatus`. Verified by `JwtAuthGuard` + Passport `JwtStrategy`.
- **Refresh Token + Durable Session**: Opaque 48-byte random token stored **only as SHA-256 hex digest** in `refresh_tokens`, linked via `familyId` to `sessions` (`ipAddress`, `userAgent`, `expiresAt`, `revokedAt`).
- **Reuse Detection**: Presenting an already-revoked refresh token immediately revokes all tokens and active sessions sharing that `familyId` and rejects with `REFRESH_TOKEN_REUSED`.

## 3. HttpOnly Cookies & Double-Submit CSRF Defense

- Login, registration, staff PIN sign-in, invitation acceptance, switch-outlet, and refresh set:
  - `anx_refresh`: `HttpOnly`, `SameSite=Lax`, `Secure` in production, scoped to `/api/v1/auth`.
  - `anx_csrf`: non-HttpOnly double-submit token (`SameSite=Lax`, path `/`) readable by `@autonex/web` to populate `X-CSRF-Token`.
- `POST /api/v1/auth/refresh` and `POST /api/v1/auth/logout` verify `anx_csrf` against `X-CSRF-Token` using constant-time `timingSafeEqual` whenever cookie-based refresh auth is used; invalid/missing CSRF headers fail with `403 CSRF_TOKEN_INVALID`.

## 4. Brute-Force Protection

- `@Throttle` limits apply to `POST /auth/register`, `POST /auth/login`, `POST /auth/staff-pin`, and `POST /auth/invitations/accept`.

