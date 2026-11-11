-- Outcome of every email the backend tries to send.
--
-- Most sends are fire-and-forget (question-set notifications to every
-- candidate, a party's candidate links in bulk), so a failure used to reach
-- only the server log. Recording each attempt lets the admin see which
-- candidates actually got their personal link.
--
-- candidate_id / party_id are set for mail addressed to a candidate / party
-- and cascade, so removing a candidate also removes their address from here.

BEGIN;

CREATE TABLE IF NOT EXISTS email_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         TEXT NOT NULL,
  recipient    TEXT NOT NULL,
  candidate_id UUID REFERENCES candidates(id) ON DELETE CASCADE,
  party_id     UUID REFERENCES parties(id) ON DELETE CASCADE,
  status       TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_email_log_candidate ON email_log (candidate_id, created_at DESC);

INSERT INTO schema_migrations (version) VALUES (13)
  ON CONFLICT DO NOTHING;

COMMIT;
