-- db/migrations/008_sovereign_auth.sql
-- PP Sovereign Auth: Independent Identity and Session Infrastructure (Append-Only)

-- 1. Extend users table for sovereign password credentials & status (Backward-Compatible)
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'INVITED'));

-- 2. Create auth_sessions table for Sovereign Refresh Token lifecycle & rotation
CREATE TABLE IF NOT EXISTS auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL,
  user_agent TEXT,
  ip_address INET,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  family_id UUID NOT NULL,
  rotated_from UUID REFERENCES auth_sessions(id) ON DELETE SET NULL
);

-- 3. Indexes for fast session lookups, reuse detection, and family revocation
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS auth_sessions_refresh_hash_idx ON auth_sessions(refresh_token_hash);
CREATE INDEX IF NOT EXISTS auth_sessions_family_idx ON auth_sessions(family_id);
CREATE INDEX IF NOT EXISTS auth_sessions_expires_revoked_idx ON auth_sessions(expires_at, revoked_at);
