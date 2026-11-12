-- Default question weight is 1 ("somewhat important"), not 0.
--
-- The weighting UI has always shown weight 1 as selected for a question the
-- voter didn't touch, and sends only the weights the voter clicked. Until this
-- fix the match route scored and stored a missing weight as 0, so rows written
-- before it hold 0 for both "not important" and "untouched". Those rows can't
-- be told apart and are left as they are. The route always supplies the
-- weight; this only keeps the column default consistent with it.

BEGIN;

ALTER TABLE voter_responses ALTER COLUMN weight SET DEFAULT 1;

INSERT INTO schema_migrations (version) VALUES (14)
  ON CONFLICT DO NOTHING;

COMMIT;
