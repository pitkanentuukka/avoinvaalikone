-- Vaalikone database schema
-- Run with: npm run migrate

BEGIN;

-- ─── Extensions ───
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── Parties ───
CREATE TABLE IF NOT EXISTS parties (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL UNIQUE,
  token         TEXT NOT NULL UNIQUE,
  email         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_parties_token ON parties (token);

-- ─── Question Sets (submitted by NGOs) ───
CREATE TABLE IF NOT EXISTS question_sets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ngo_name      TEXT NOT NULL,
  ngo_email     TEXT,
  logo_url      TEXT,
  title         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'rejected')),
  submitted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_question_sets_status ON question_sets (status);

-- ─── Questions ───
CREATE TABLE IF NOT EXISTS questions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_set_id UUID NOT NULL REFERENCES question_sets (id) ON DELETE CASCADE,
  statement       TEXT NOT NULL,
  sort_order      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_questions_set ON questions (question_set_id);

-- ─── Candidates ───
CREATE TABLE IF NOT EXISTS candidates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  party_id      UUID NOT NULL REFERENCES parties (id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  photo_url     TEXT,
  bio           TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_candidates_party ON candidates (party_id);

-- ─── Candidate Answers ───
CREATE TABLE IF NOT EXISTS candidate_answers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id  UUID NOT NULL REFERENCES candidates (id) ON DELETE CASCADE,
  question_id   UUID NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  value         INTEGER NOT NULL CHECK (value >= 0 AND value <= 4),
  explanation   TEXT DEFAULT '',
  answered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (candidate_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_answers_candidate ON candidate_answers (candidate_id);
CREATE INDEX IF NOT EXISTS idx_answers_question  ON candidate_answers (question_id);

-- ─── Schema version tracking ───
CREATE TABLE IF NOT EXISTS schema_migrations (
  version       INTEGER PRIMARY KEY,
  applied_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (version) VALUES (1)
  ON CONFLICT DO NOTHING;

COMMIT;
