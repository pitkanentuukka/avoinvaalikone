-- Covering index for the voter match query, which now selects only
-- (candidate_id, question_id, value) filtered by question_id. INCLUDE (value)
-- enables index-only scans.
BEGIN;

CREATE INDEX IF NOT EXISTS idx_candidate_answers_qid_cid_value
  ON candidate_answers (question_id, candidate_id) INCLUDE (value);

INSERT INTO schema_migrations (version) VALUES (10) ON CONFLICT DO NOTHING;

COMMIT;
