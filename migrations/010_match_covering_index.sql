-- Covering index for the voter match query, which now selects only
-- (candidate_id, question_id, value) filtered by question_id. INCLUDE (value)
-- enables index-only scans.
--
-- Built CONCURRENTLY so it does not take a write lock on candidate_answers:
-- candidates may still be editing answers during a campaign-period deploy, and
-- every replica runs migrations on startup during a rolling deploy. That means
-- this file must NOT run inside a transaction, so — unlike the other
-- migrations — it has no BEGIN/COMMIT and does not write schema_migrations
-- (which nothing reads; the runner records applied migrations in
-- migration_history). The runner executes each file as its own query with the
-- session in autocommit between migrations, so this single statement runs
-- outside any transaction block.
--
-- If a CONCURRENTLY build is interrupted it can leave an INVALID index that
-- IF NOT EXISTS will not rebuild. To recover, drop it and let the migration
-- re-run:  DROP INDEX IF EXISTS idx_candidate_answers_qid_cid_value;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_candidate_answers_qid_cid_value
  ON candidate_answers (question_id, candidate_id) INCLUDE (value);
