BEGIN;

ALTER TABLE voter_responses ADD COLUMN IF NOT EXISTS weight INTEGER NOT NULL DEFAULT 0 CHECK (weight >= 0 AND weight <= 3);

INSERT INTO schema_migrations (version) VALUES (5)
  ON CONFLICT DO NOTHING;

COMMIT;
