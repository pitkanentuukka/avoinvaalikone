BEGIN;

-- Anonymous voter response storage for aggregate analysis.
-- No IP, no user agent, no precise timestamp — only a random session UUID and date.
-- The session_id is generated server-side at match time; it cannot be linked to any individual.
CREATE TABLE IF NOT EXISTS voter_responses (
  session_id   UUID    NOT NULL,
  question_id  UUID    NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  value        INTEGER NOT NULL CHECK (value >= 0 AND value <= 4),
  answered_on  DATE    NOT NULL DEFAULT CURRENT_DATE,
  PRIMARY KEY (session_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_voter_responses_question ON voter_responses (question_id);
CREATE INDEX IF NOT EXISTS idx_voter_responses_date     ON voter_responses (answered_on);

INSERT INTO schema_migrations (version) VALUES (3)
  ON CONFLICT DO NOTHING;

COMMIT;
