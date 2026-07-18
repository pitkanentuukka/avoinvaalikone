-- Add constituency column to candidates
-- Run with: npm run migrate

BEGIN;

ALTER TABLE candidates ADD COLUMN IF NOT EXISTS constituency TEXT;

CREATE INDEX IF NOT EXISTS idx_candidates_constituency ON candidates (constituency);

INSERT INTO schema_migrations (version) VALUES (3)
  ON CONFLICT DO NOTHING;

COMMIT;
