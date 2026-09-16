-- db/migrations/009_account_claim_tokens.sql
-- PP Sovereign Auth: Account Claim & Identity Transition Tokens (Phase 4.4)

CREATE TABLE IF NOT EXISTS account_claim_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_claim_tokens_hash_idx ON account_claim_tokens(token_hash);
CREATE INDEX IF NOT EXISTS account_claim_tokens_user_idx ON account_claim_tokens(user_id);
