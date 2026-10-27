-- Per-candidate access tokens and party self-registration links.
--
-- Previously the party token was the only credential: it was emailed to every
-- candidate, so any candidate could edit every other candidate in the party.
-- Now:
--   candidates.token          — the candidate's personal link; the only
--                                credential that can change their profile
--                                and answers.
--   parties.registration_token — a register-only link the party secretary
--                                shares with candidates; rotatable without
--                                affecting the party token or existing
--                                candidates.
--   parties.token             — unchanged; the secretary's management access
--                                (overview, re-send links, remove sign-ups).
--
-- 24 random bytes (192 bits) from pgcrypto, same strength as party tokens.

BEGIN;

ALTER TABLE candidates ADD COLUMN IF NOT EXISTS token TEXT;
UPDATE candidates SET token = encode(gen_random_bytes(24), 'hex') WHERE token IS NULL;
ALTER TABLE candidates ALTER COLUMN token SET DEFAULT encode(gen_random_bytes(24), 'hex');
ALTER TABLE candidates ALTER COLUMN token SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_token ON candidates (token);

ALTER TABLE parties ADD COLUMN IF NOT EXISTS registration_token TEXT;
UPDATE parties SET registration_token = encode(gen_random_bytes(24), 'hex') WHERE registration_token IS NULL;
ALTER TABLE parties ALTER COLUMN registration_token SET DEFAULT encode(gen_random_bytes(24), 'hex');
ALTER TABLE parties ALTER COLUMN registration_token SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_parties_registration_token ON parties (registration_token);

INSERT INTO schema_migrations (version) VALUES (11)
  ON CONFLICT DO NOTHING;

COMMIT;
