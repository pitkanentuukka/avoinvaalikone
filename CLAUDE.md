# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Vaalikone 2026 is a Finnish voter advisory machine (election compass). Voters answer policy questions and are matched with candidates based on answer similarity. It consists of a Node/Express backend (repo root) and a React frontend (`vaalikone-frontend/`).

## Commands

### Backend (repo root)

```bash
npm install           # Install dependencies
npm run dev           # Start with hot-reload (node --watch)
npm start             # Start in production mode
npm run migrate       # Run database migrations
npm run seed          # Seed sample data
```

### Frontend (`vaalikone-frontend/`)

```bash
cd vaalikone-frontend
npm install
npm run dev           # Vite dev server at http://localhost:5173
npm run build         # Production build
npm run lint          # ESLint
npm run preview       # Preview production build
```

### Docker (full stack)

```bash
docker compose --profile dev up --build   # Start all services incl. mailpit (local SMTP capture)
docker compose up --build                 # Start without mailpit
docker compose down                       # Stop all services
```

`mailpit` (dev SMTP capture, web UI at http://localhost:8025) is gated behind the `dev` Compose profile, so it only starts when you pass `--profile dev`. Production (`docker-compose.prod.yml`) never requests the profile, so mailpit is absent there.

## Architecture

### Backend

- **Entry point:** `src/index.js` — Express app setup, middleware, route mounting, and rate limiters
- **Database:** `src/db/pool.js` — PostgreSQL connection pool via `pg`
- **Auth middleware:** `src/middleware/auth.js`
  - `requireAdmin` — timing-safe comparison against `ADMIN_SECRET` env var
  - `requirePartyToken` — looks up party by URL param `:partyToken`, attaches `req.party` (secretary's management access)
  - `requireRegistrationToken` — looks up party by `:registrationToken` (shareable sign-up link), attaches `req.party`
  - `requireCandidateToken` — looks up candidate by `:candidateToken` (personal link), attaches `req.candidate`
- **Validation middleware:** `src/middleware/validation.js` — UUID validation, field length checks, range validation
- **Routes:**
  - `src/routes/parties.js` — admin CRUD for political parties; party creation returns a secret `token`. Admin can also rotate a party token, list a party's candidates **with** their personal tokens (the only place they're visible besides the candidate themself), and email every candidate their link.
  - `src/routes/questionSets.js` — NGO question set submissions (public), approval workflow (admin), and duplicate-question merging. A question is canonical and may belong to **several** sets via the `question_set_questions` join table; `mergeQuestions()` moves a duplicate's set links onto a canonical question and reconciles candidate answers (the canonical question's own answer is authoritative — its wording is what voters see; a duplicate's answer is carried over only for candidates who never answered the canonical question). Inline merge happens per-question during `/review` (a `duplicateOf` field on each review item); after publish, `POST /admin/question-sets/merge-questions` (`{ keepId, dropIds }`) merges retroactively.
  - `src/routes/candidates.js` — public reads plus three token tiers. **Party token** (`/party/:partyToken`): overview, rotate the registration link, re-send a candidate's link, remove candidates — it never sees candidate tokens, so it cannot edit profiles or answers. **Registration token** (`/register/:registrationToken`): candidate self-registration; candidates are visible to voters immediately; same name + email again re-sends the existing link instead of creating a duplicate. **Candidate token** (`/me/:candidateToken`): the only credential that can edit a candidate's own profile and answers.
  - `src/routes/voter.js` — match computation: weighted similarity scoring (answers 0–4 scale, weights 0–3)

**Rate limiting** (every limiter, including the per-token ones in `src/routes/candidates.js`, is skipped unless `NODE_ENV=production`):
- Admin: 30 req / 15 min, counting only requests without a valid `ADMIN_SECRET` (brute-force protection; an authenticated admin is never throttled)
- NGO submissions: 20 req / 15 min
- Voter match: 300 req / 1 min by default, set with `RATE_LIMIT_MATCH_MAX` (headroom for carrier CGNAT on election night; see `docs/scaling.md`)

**Match algorithm** (`src/match.js`, called from `src/routes/voter.js`): For each question the voter answered, computes `similarity = 1 - |voterValue - candidateValue| / 4`, multiplied by `weight + 1` (so weight 0 → factor 1, weight 3 → factor 4). A question the candidate skipped counts as similarity 0 with the voter's weight. Without that, a candidate who answered one question and agreed would get 100%. A question with no weight in the request counts as weight 1 (`DEFAULT_WEIGHT`), because the weighting UI shows "somewhat important" as selected and only sends weights the voter clicked; the same default is stored in `voter_responses`. Scores are averaged over all of the voter's scored questions and returned as a percentage, with `questionCount` in the response so the UI can show "vastannut X/Y". Results sort by match, then `answeredCount`, then name. When the voter restricts to certain sets, only the voter's questions in those sets are scored. Set membership is tested with `EXISTS` against `question_set_questions` (not a column on `questions`), so a question shared by multiple selected sets is still counted once.

### Frontend

Everything lives in `vaalikone-frontend/src/App.jsx` — a single-file React app — except the API client in `vaalikone-frontend/src/api.js` and the magic-link parsing in `vaalikone-frontend/src/tokenLinks.js`, both kept free of Vite-only syntax so the unit tests (`tests/unit/apiClient.test.js`, `tests/unit/tokenLinks.test.js`) can `import()` them (`npm test` runs Jest with `--experimental-vm-modules` for this). The token is scrubbed from the address bar on load but kept in the tab's `sessionStorage`, so a reload reopens the same view. Only a reload (Navigation Timing `type === "reload"`): any other load without a token in the URL — a fresh visit, Back/Forward once the page has left the back/forward cache, a reopened or restored tab — forgets it, because sessionStorage outlives visits to other sites in the same tab and so the next person on a shared computer would get the link. A page still in the back/forward cache is shown as it was, so Back into it is beyond this protection. Header navigation forgets it, and an error boundary forgets it on a render crash so a broken view isn't reopened on every reload. `api.js` contains:
- `apiFetch` helper with automatic snake_case ↔ camelCase conversion. It retries once on 502/503/504 or a network error, but only `GET`s and requests passing `retry: true`; a non-idempotent request may already have taken effect when its response was lost. The match POST opts in because the client generates its `sessionId` and resends the same one, so the retry's research insert is a no-op. A failed request throws an `Error` carrying the HTTP `status`, or `network: true` when `fetch` itself failed. `isTransientError()` is true for those except a 400 or 404 (what the token routes send for a malformed or unknown token): the token-gated views offer a retry for transient errors and show "invalid link" otherwise.
- `createApi()`, returning the `api` object with typed methods for all backend endpoints

`App.jsx` contains:
- Multiple view components rendered based on `currentView` state
- Views: voter quiz, results, admin panel (parties, question set approval), NGO submission form, candidate registration

The `API_BASE` constant at the top of `App.jsx` defaults to same-origin `/api`; override it with `VITE_API_BASE` at build time.

### Database Schema

Tables: `parties` → `candidates` → `candidate_answers`; `question_sets` ↔ `questions` (many-to-many via the `question_set_questions` join table, which also carries each set's `sort_order`). `candidate_answers` and `voter_responses` reference `questions.id` directly, so a canonical question keeps a single answer target no matter how many sets share it. All primary keys are UUIDs generated by PostgreSQL `gen_random_uuid()`. Question set approval status is `pending | approved | rejected`.

When a set or a per-set link is removed, the route layer deletes any question that is no longer linked to **any** set (`deleteOrphanQuestions()`); deleting a question cascades to its `candidate_answers` and `voter_responses`.

**Email:** `src/email.js` sends everything through one pooled nodemailer transport (`SMTP_MAX_CONNECTIONS`, default 3), so bulk fire-and-forget sends queue instead of opening a connection per message. Every attempt is recorded in `email_log` (`sent | failed`, with the error); rows addressed to a candidate or party cascade on its deletion. The admin's per-party candidate list shows each candidate's latest outcome.

**Constituency constraint:** `candidates.constituency` has a CHECK constraint (`candidates_constituency_valid`) that allows only the 13 Finnish parliamentary constituencies (eduskuntavaalit). The same list is hardcoded in `FI_CONSTITUENCIES` in `vaalikone-frontend/src/App.jsx`. **If repurposing for other elections** (municipal elections, other countries), both must be updated: drop/replace the constraint in a new migration and update the frontend constant.

### Environment Variables

Copy `.env.example` to `.env`. Required: `DATABASE_URL`, `ADMIN_SECRET`. Optional: `PORT` (default 3000), `CORS_ORIGIN` (default `http://localhost:5173`), `NODE_ENV`, `PUBLIC_HOST` (production HTTPS-redirect target), `TRUST_PROXY_HOPS` (number of reverse proxies in front of the app, default 1; the production Cloudflare → Caddy → nginx chain needs 3, set in `docker-compose.prod.yml`), `RATE_LIMIT_MATCH_MAX` (voter match requests per IP per minute, default 300).

## Key Conventions

- Error messages and UI text are in **Finnish**
- All DB queries use parameterized statements (`$1`, `$2`, …) — no string interpolation
- Transactions use `begin`/`commit`/`rollback` from `src/db/transaction.js`, never raw `client.query("BEGIN")` etc.: `rollback()` only sends ROLLBACK for a transaction `begin()` opened (and ignores a failed one), so a raw `BEGIN` makes it a silent no-op
- Admin endpoints are mounted at `/api/admin/*`; token-gated endpoints use `/api/candidates/party/:partyToken/...`, `/api/candidates/register/:registrationToken`, and `/api/candidates/me/:candidateToken/...`
- Tokens are 24 random bytes from pgcrypto (`encode(gen_random_bytes(24), 'hex')` column defaults; rotate with `SET col = DEFAULT`)
- API behaviour that only direct API clients can hit (the frontend never triggers it) is documented in `docs/direct-api-caveats.md` rather than fixed for now; add new cases there
- Migrations run as a single SQL transaction (`migrations/001_initial.sql`); new migrations should follow the same versioned pattern and update `schema_migrations`

## Issue Workflow

Bugs and tasks are tracked as GitHub issues (`pitkanentuukka/avoinvaalikone`). When working on an issue:

1. Create a branch named after the issue: `<number>-short-summary`.
2. Write tests that reproduce the issue. Prefer unit tests (`tests/unit/`); use integration tests (`tests/routes/`) only if unit tests can't cover it, and end-to-end tests (`e2e/`) only if nothing else works.
   Run them and confirm they fail for the reason described in the issue.
3. Commit and open a draft PR with `Fixes #<number>` in the description.
4. Implement the fix. Run the full test suite (`npm test`, plus `npm run lint` in `vaalikone-frontend/` if the frontend changed); everything must pass.
5. Review loop:
   - Spawn a fresh review agent with only the issue and the code in context. Point it at `git diff main...HEAD` as the starting point, but let it read any code it needs.
   - Post its findings as a PR comment (`Review round N`).
   - Sort findings into: caused by or related to this change, or pre-existing and unrelated.
   - Pre-existing, unrelated bugs: collect them and keep going. Don't fix them on this branch, and they don't trigger another round.
   - Fix all related findings. Write a test for each functional bug where feasible.
   - If any related finding was functional, run the full test suite and start a new round.
   - If only nits/cosmetic/non-functional findings remain, fix them, run the full test suite, and exit the loop without another review.
   - If a finding contradicts an earlier round's fix, stop and ask the user.
6. Mark the PR ready for review and summarise what was fixed in each round.
   List the collected pre-existing bugs and ask the user which ones to file as issues.
   The user reviews and merges.
