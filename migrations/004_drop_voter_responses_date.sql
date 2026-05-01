BEGIN;

-- Remove date column from voter_responses to prevent correlation with access logs.
DROP INDEX IF EXISTS idx_voter_responses_date;
ALTER TABLE voter_responses DROP COLUMN IF EXISTS answered_on;

INSERT INTO schema_migrations (version) VALUES (4)
  ON CONFLICT DO NOTHING;

COMMIT;
