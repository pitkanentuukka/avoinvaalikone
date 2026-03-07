-- Add hidden flag to question_sets for admin soft-hide

BEGIN;

ALTER TABLE question_sets
  ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_question_sets_hidden ON question_sets (hidden);

INSERT INTO schema_migrations (version) VALUES (2)
  ON CONFLICT DO NOTHING;

COMMIT;
