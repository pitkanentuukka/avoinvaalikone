BEGIN;

ALTER TABLE candidates ADD COLUMN IF NOT EXISTS email TEXT;

INSERT INTO schema_migrations(version) VALUES (2);

COMMIT;
