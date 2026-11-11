-- Rotate every party token.
--
-- Before 011 the party token was the only credential and was emailed to every
-- candidate (?view=candidate&partyToken=…). Since 011 it is the secretary's
-- management access — it can remove candidates, rotate the registration link
-- and see candidates' email addresses — so the copies candidates already hold
-- must stop working. After this runs, the admin hands each party secretary
-- their new token from the admin panel.
--
-- Same format as src/routes/parties.js: a readable slug of the party name
-- plus 24 random bytes, base64url-encoded (24 bytes → 32 chars, no padding).
-- Upper-case Ä/Å/Ö are mapped explicitly because lower() only folds ASCII
-- under a C locale.

BEGIN;

UPDATE parties
SET token = left(regexp_replace(translate(lower(name), 'ÄÅÖäåö', 'aaoaao'), '[^a-z0-9]+', '-', 'g'), 12)
         || '-'
         || translate(encode(gen_random_bytes(24), 'base64'), '+/', '-_');

INSERT INTO schema_migrations (version) VALUES (12)
  ON CONFLICT DO NOTHING;

COMMIT;
