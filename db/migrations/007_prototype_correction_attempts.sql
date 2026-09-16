-- db/migrations/007_prototype_correction_attempts.sql
-- PP 2.1: Autonomous Verification Recovery Loop Lineage & Concurrency Protection

CREATE TABLE IF NOT EXISTS prototype_correction_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES prototype_sessions(id) ON DELETE RESTRICT,
  task_id UUID NOT NULL REFERENCES prototype_tasks(id) ON DELETE CASCADE,
  source_verification_id UUID NOT NULL REFERENCES prototype_verifications(id) ON DELETE RESTRICT,
  source_checkpoint_id UUID NOT NULL REFERENCES prototype_checkpoints(id) ON DELETE RESTRICT,
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'ESCALATED')),
  result_commit_sha TEXT,
  result_checkpoint_id UUID REFERENCES prototype_checkpoints(id) ON DELETE SET NULL,
  result_verification_id UUID REFERENCES prototype_verifications(id) ON DELETE SET NULL,
  failure_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_source_verification_attempt UNIQUE (source_verification_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS prototype_correction_attempts_session_idx ON prototype_correction_attempts(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS prototype_correction_attempts_source_verif_idx ON prototype_correction_attempts(source_verification_id);
CREATE INDEX IF NOT EXISTS prototype_correction_attempts_result_cp_idx ON prototype_correction_attempts(result_checkpoint_id);
CREATE INDEX IF NOT EXISTS prototype_correction_attempts_status_idx ON prototype_correction_attempts(status);
