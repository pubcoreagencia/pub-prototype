-- db/migrations/006_prototype_verifications.sql
-- PP 2.0: Mandatory Product Verification Gate & Immutable Verifications

CREATE TABLE IF NOT EXISTS prototype_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES prototype_sessions(id) ON DELETE RESTRICT,
  checkpoint_id UUID NOT NULL REFERENCES prototype_checkpoints(id) ON DELETE RESTRICT,
  commit_sha TEXT NOT NULL,
  pipeline_version TEXT NOT NULL DEFAULT 'v1',
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'PASSED', 'FAILED')),
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS prototype_verifications_session_idx ON prototype_verifications(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS prototype_verifications_checkpoint_idx ON prototype_verifications(checkpoint_id);
CREATE INDEX IF NOT EXISTS prototype_verifications_commit_idx ON prototype_verifications(commit_sha);
CREATE INDEX IF NOT EXISTS prototype_verifications_status_idx ON prototype_verifications(status);

-- Enforcement of Immutability: Prototype verifications are historical audit artifacts.
-- INSERT = allowed; UPDATE = forbidden; DELETE = forbidden.
CREATE OR REPLACE FUNCTION prevent_verification_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'UPDATE on prototype_verifications is forbidden: verification records are immutable audit records';
  ELSIF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DELETE on prototype_verifications is forbidden: verification records are immutable audit records';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_prototype_verifications_immutable ON prototype_verifications;
CREATE TRIGGER trg_prototype_verifications_immutable
BEFORE UPDATE OR DELETE ON prototype_verifications
FOR EACH ROW
EXECUTE FUNCTION prevent_verification_mutation();
