-- At most one candidate per party, name and email address (issue #151).
--
-- Self-registration treats a repeat sign-up with the same name and address
-- (case-insensitive, trimmed) as a candidate who lost their link and re-sends
-- it instead of creating a second profile. That check ran before a separate
-- INSERT, so two overlapping sign-ups (a double submit, two tabs) could both
-- pass it and create two public profiles with different personal links. The
-- unique index below makes the database refuse the second one.
--
-- Rows without an email address (created before 002) are not constrained:
-- NULLs are distinct in a unique index, and registration always requires one.
--
-- Existing duplicates are merged first. Per identity, the candidate with the
-- most answers is kept (then the most recently updated, then the oldest).
-- A duplicate's answer to a question the kept candidate never answered is
-- carried over, the most recent one if several duplicates answered it. The
-- duplicates are then deleted with their own answers and email_log rows; a
-- candidate who still uses a deleted duplicate's link gets the kept link back
-- by signing up again with the same name and address. The number of merged
-- duplicates is printed as a NOTICE (migrations/run.js logs notices).
--
-- Lock out writers for the merge: a backend still running the old code could
-- otherwise save answers to a duplicate after the carry-over (lost with the
-- cascade) or register a new duplicate before the index exists. The lock on
-- candidate_answers is needed too, as answer inserts only take a KEY SHARE
-- row lock on candidates, which SHARE ROW EXCLUSIVE does not block.


LOCK TABLE candidates, candidate_answers IN SHARE ROW EXCLUSIVE MODE;

-- Dropped explicitly below rather than ON COMMIT DROP: outside a transaction
-- (psql -f by hand) that would drop it at the end of this very statement.
CREATE TEMP TABLE candidate_duplicates AS
SELECT id AS drop_id, keep_id
FROM (
  SELECT c.id,
         first_value(c.id) OVER w AS keep_id,
         row_number() OVER w AS rn
  FROM candidates c
  CROSS JOIN LATERAL (
    SELECT count(*) AS answers FROM candidate_answers a WHERE a.candidate_id = c.id
  ) a
  WHERE c.email IS NOT NULL
  WINDOW w AS (
    PARTITION BY c.party_id, lower(btrim(c.name)), lower(btrim(c.email))
    ORDER BY a.answers DESC, c.updated_at DESC, c.created_at, c.id
  )
) ranked
WHERE rn > 1;

INSERT INTO candidate_answers (candidate_id, question_id, value, explanation, answered_at)
SELECT DISTINCT ON (d.keep_id, a.question_id)
       d.keep_id, a.question_id, a.value, a.explanation, a.answered_at
FROM candidate_duplicates d
JOIN candidate_answers a ON a.candidate_id = d.drop_id
ORDER BY d.keep_id, a.question_id, a.answered_at DESC, a.candidate_id
ON CONFLICT (candidate_id, question_id) DO NOTHING;

DELETE FROM candidates WHERE id IN (SELECT drop_id FROM candidate_duplicates);

DO $$
DECLARE merged integer;
BEGIN
  SELECT count(*) INTO merged FROM candidate_duplicates;
  IF merged > 0 THEN
    RAISE NOTICE 'Merged % duplicate candidate registration(s) into the kept candidate; their links no longer work', merged;
  END IF;
END $$;

DROP TABLE candidate_duplicates;

-- The same expressions as the duplicate check and ON CONFLICT target in
-- src/routes/candidates.js; they must stay identical for the index to be
-- used and for ON CONFLICT to infer it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_registration_identity
  ON candidates (party_id, lower(btrim(name)), lower(btrim(email)));

INSERT INTO schema_migrations (version) VALUES (15)
  ON CONFLICT DO NOTHING;
