-- Enforce valid constituency values for Finnish parliamentary elections (eduskuntavaalit 2026).
--
-- IMPORTANT: If this app is repurposed for other elections (municipal elections,
-- other countries), remove or replace this constraint and update FI_CONSTITUENCIES
-- in vaalikone-frontend/src/App.jsx to match.

BEGIN;

ALTER TABLE candidates
  DROP CONSTRAINT IF EXISTS candidates_constituency_valid;

ALTER TABLE candidates
  ADD CONSTRAINT candidates_constituency_valid
  CHECK (constituency IN (
    'Helsingin vaalipiiri',
    'Uudenmaan vaalipiiri',
    'Varsinais-Suomen vaalipiiri',
    'Satakunnan vaalipiiri',
    'Ahvenanmaan maakunnan vaalipiiri',
    'Hämeen vaalipiiri',
    'Pirkanmaan vaalipiiri',
    'Kaakkois-Suomen vaalipiiri',
    'Savo-Karjalan vaalipiiri',
    'Vaasan vaalipiiri',
    'Keski-Suomen vaalipiiri',
    'Oulun vaalipiiri',
    'Lapin vaalipiiri'
  ));

INSERT INTO schema_migrations (version) VALUES (8)
  ON CONFLICT DO NOTHING;

COMMIT;
