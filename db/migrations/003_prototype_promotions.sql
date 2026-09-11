-- db/migrations/003_prototype_promotions.sql
-- Promotion audit log from PROTOTYPE to DEVELOPMENT

CREATE TABLE IF NOT EXISTS prototype_promotions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES prototype_sessions(id) ON DELETE CASCADE,
  from_mode TEXT NOT NULL DEFAULT 'PROTOTYPE' CHECK (from_mode = 'PROTOTYPE'),
  to_mode TEXT NOT NULL DEFAULT 'DEVELOPMENT' CHECK (to_mode = 'DEVELOPMENT'),
  repository TEXT NOT NULL,
  branch TEXT NOT NULL,
  checkpoint_sha TEXT NOT NULL,
  promoted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS prototype_promotions_session_idx
  ON prototype_promotions (session_id, promoted_at DESC);
