-- Covering index for the voter match query. INCLUDE (value) enables
-- index-only scans for (candidate_id, question_id, value).
--
-- Use a regular index build so the runner can commit the index and its
-- migration_history row atomically. This blocks candidate_answers writes
-- during the build; databases that already recorded migration 010 skip it.
-- A failed earlier CONCURRENTLY build may have left an INVALID index;
-- drop that index before retrying this migration:
--   DROP INDEX IF EXISTS idx_candidate_answers_qid_cid_value;
CREATE INDEX IF NOT EXISTS idx_candidate_answers_qid_cid_value
  ON candidate_answers (question_id, candidate_id) INCLUDE (value);
