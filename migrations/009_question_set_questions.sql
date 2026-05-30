-- Many-to-many between question sets and questions.
--
-- Previously each question belonged to exactly one set (questions.question_set_id).
-- That forced admins to DELETE duplicate questions during dedup, which silently
-- dropped them from any other NGO set that posed them — breaking the promise that
-- voters can pick and choose NGO sets freely. Now a single canonical question can
-- be linked to many sets via question_set_questions, so dedup links instead of deletes.
--
-- candidate_answers and voter_responses keep referencing questions.id, so a merged
-- (canonical) question keeps a single answer target regardless of how many sets share it.

BEGIN;

CREATE TABLE IF NOT EXISTS question_set_questions (
  question_set_id UUID    NOT NULL REFERENCES question_sets (id) ON DELETE CASCADE,
  question_id     UUID    NOT NULL REFERENCES questions (id)     ON DELETE CASCADE,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (question_set_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_qsq_set      ON question_set_questions (question_set_id);
CREATE INDEX IF NOT EXISTS idx_qsq_question ON question_set_questions (question_id);

-- Backfill one link row per existing question, preserving its sort order.
INSERT INTO question_set_questions (question_set_id, question_id, sort_order)
SELECT question_set_id, id, sort_order
FROM questions
ON CONFLICT DO NOTHING;

-- The single-set column is now superseded by the join table.
DROP INDEX IF EXISTS idx_questions_set;
ALTER TABLE questions DROP COLUMN IF EXISTS question_set_id;

INSERT INTO schema_migrations (version) VALUES (9)
  ON CONFLICT DO NOTHING;

COMMIT;
