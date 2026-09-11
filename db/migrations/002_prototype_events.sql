-- db/migrations/002_prototype_events.sql
-- Operational events and persistent idempotency index

CREATE TABLE IF NOT EXISTS prototype_events (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES prototype_sessions(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  sequence BIGINT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS prototype_events_session_idx
  ON prototype_events (session_id, created_at ASC, sequence ASC);

CREATE UNIQUE INDEX IF NOT EXISTS prototype_events_idempotency_idx
  ON prototype_events (
    session_id,
    (payload->>'taskId'),
    ((payload->>'attempt')::int),
    ((payload->>'operationalSeq')::bigint),
    type
  )
  WHERE (payload->>'taskId') IS NOT NULL
    AND (payload->>'attempt') IS NOT NULL
    AND (payload->>'operationalSeq') IS NOT NULL;
