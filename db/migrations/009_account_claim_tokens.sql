-- db/migrations/009_account_claim_tokens.sql
-- PP Sovereign Auth: Account Claim & Identity Transition Tokens (Phase 4.4)

CREATE TABLE IF NOT EXISTS account_claim_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'PENDING'
);

CREATE INDEX IF NOT EXISTS account_claim_tokens_hash_idx ON account_claim_tokens(token_hash);
CREATE INDEX IF NOT EXISTS account_claim_tokens_user_idx ON account_claim_tokens(user_id);
-- Partial unique index to ensure at most one active (unused) claim per user
CREATE UNIQUE INDEX IF NOT EXISTS account_claim_tokens_one_active_per_user_idx
  ON account_claim_tokens(user_id)
  WHERE used_at IS NULL AND status = 'PENDING';

-- Retention policy: Claim tokens and audit records are retained for at least 30 days for security analysis.

