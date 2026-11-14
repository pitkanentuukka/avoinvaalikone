# Vaalikone 2026

A Finnish *voter advisory machine* (vaalikone / election compass): voters answer a set of policy statements, candidates answer the same statements, and the app ranks candidates by how closely their answers match the voter's.

**Stack:** Node.js + Express + PostgreSQL (backend) · React 19 + Vite (frontend) · Docker Compose (full stack)

---

## What this is

Most Finnish vaalikoneet are built and owned by a single media house (Yle, Helsingin Sanomat, MTV…). One editorial team writes every question, and the resulting compass reflects that single team's view of what matters in the election.

**This project is different: it is built around many organizations contributing questions, not one.** Civil-society organizations — NGOs, unions, advocacy groups, associations — each submit their *own* thematic set of statements. An administrator moderates the submissions, and the approved sets are published side by side. The result is an election compass assembled from many independent voices rather than a single editorial desk.

### The multi-NGO model

The whole system is shaped around this idea. Three groups of people interact with it, and the design keeps them deliberately decoupled:

- **🏛️ Organizations (NGOs)** propose **question sets** — a titled, themed bundle of policy statements (e.g. *"Climate & energy"* from one group, *"Education"* from another). Anyone can submit one through a public form; no account is needed. Each set carries the submitting organization's name (and optional logo), so its origin stays visible all the way to the voter.
- **🛡️ The administrator** is the neutral moderator. They review every incoming set and approve, edit, or reject it. The admin does **not** author the questions — their job is curation and quality control across all the organizations' submissions. Only approved sets become visible to candidates and voters.
- **🗳️ Voters** don't get one monolithic questionnaire. On starting the compass they see **every approved set listed by theme and by the organization behind it**, and they freely **mix and match** which sets to answer — all of them, or just the themes they care about, drawn from whichever organizations they like. Their match is computed only over the questions they actually chose.

Candidates, in turn, answer the pooled approved questions (each through a personal link, after signing up via their party's registration link) so that whatever combination a voter picks, there are candidate answers to match against.

```
      Many NGOs                Admin                      Voter
 ┌──────────────────┐    ┌───────────────┐       ┌──────────────────┐
 │ Set: Climate     │    │               │       │ picks themes from │
 │ Set: Education    │──► │  moderates &  │ ───►  │ any mix of NGOs,  │
 │ Set: Health      │    │   approves    │ appr. │ then gets matched │
 │ …                │    │     sets      │ sets  │ to candidates     │
 └──────────────────┘    └───────────────┘       └──────────────────┘
       (decoupled: no NGO sees another's; the voter sees the union)
```

Because question authorship is distributed, the compass can grow organically: a new organization can add a perspective the others missed without anyone rebuilding the questionnaire. The trade-off — and the reason the admin role exists — is that submissions need moderation to stay neutral, non-leading, and free of duplicates.

> **Repurposing:** this is currently scoped to the 2026 Finnish parliamentary election (the 13 eduskuntavaalit constituencies are baked into a DB constraint and a frontend constant). To run it for other elections, update both — see *Database Schema* below and `CLAUDE.md`.

---

## Quick Start

### Docker (recommended)

```bash
docker compose up --build
```

| Service  | URL                     | Notes                                  |
|----------|-------------------------|----------------------------------------|
| Frontend | http://localhost        | Nginx-served SPA on port **80**        |
| Backend  | http://localhost:3000   | Express API (`/api/...`)               |
| Mailpit  | http://localhost:8025   | Local email capture UI (dev only)      |
| Postgres | `localhost:5433`        | Database, mapped from container `5432` |

### Local Development

**Backend** (repo root):

```bash
cp .env.example .env       # fill in DATABASE_URL and ADMIN_SECRET
createdb vaalikone
npm install
npm run migrate
npm run seed               # optional sample data
npm run dev                # starts on http://localhost:3000
```

**Frontend** (`vaalikone-frontend/`):

```bash
cd vaalikone-frontend
npm install
npm run dev                # Vite dev server at http://localhost:5173
```

---

## Architecture

```
vaalikone/
├── src/
│   ├── index.js              # Express entry point, rate limiters, route mounting
│   ├── db/pool.js            # PostgreSQL connection pool
│   ├── email.js              # Nodemailer SMTP notifications
│   ├── middleware/
│   │   ├── auth.js           # requireAdmin (timing-safe Bearer), party/registration/candidate token lookups
│   │   └── validation.js     # UUID, field length, range validators
│   └── routes/
│       ├── parties.js        # Admin CRUD for political parties
│       ├── questionSets.js   # NGO submissions + admin approval workflow
│       ├── candidates.js     # Candidate profiles and answers
│       └── voter.js          # Weighted similarity match algorithm
├── migrations/
│   ├── 001_initial.sql       # Core schema (all tables)
│   ├── 002_candidate_email.sql
│   ├── 003_voter_responses.sql
│   ├── run.js                # Migration runner
│   └── seed.js               # Sample data
├── tests/
│   ├── routes/               # Integration tests (supertest)
│   └── unit/                 # Unit tests (auth, validation, frontend API client)
├── vaalikone-frontend/
│   ├── src/
│   │   ├── App.jsx           # Entire SPA — views, components
│   │   ├── api.js            # API client
│   │   └── main.jsx
│   ├── Dockerfile            # Multi-stage Nginx build
│   └── nginx.conf
├── docker-compose.yml
└── .env.example
```

---

## Database Schema

| Table | Key Columns | Notes |
|-------|-------------|-------|
| **parties** | id, name, token, registration_token, email | `token`: secretary's management access; `registration_token`: shareable sign-up link (rotatable) |
| **candidates** | id, party_id, name, photo_url, bio, email, token | `token`: the candidate's personal link — the only credential that can edit their profile and answers |
| **candidate_answers** | candidate_id, question_id, value (0–4), explanation | Unique per candidate+question |
| **question_sets** | id, ngo_name, ngo_email, title, status, hidden | `status`: `pending \| approved \| rejected` |
| **questions** | id, statement | Canonical question; may belong to several sets |
| **question_set_questions** | question_set_id, question_id, sort_order | Join table (a question ↔ many sets, per-set ordering) |
| **voter_responses** | session_id, question_id, value, weight | Anonymous analytics (no PII). `weight` of an unweighted question is 1; rows stored before migration 014 recorded 0 for those, so their 0s mix "not important" with "untouched" |

All primary keys are UUIDs (`gen_random_uuid()`). New migrations should follow the versioned pattern and update `schema_migrations`.

---

## API Reference

### Authentication

| Type | Mechanism |
|------|-----------|
| Admin | `Authorization: Bearer <ADMIN_SECRET>` header |
| Party secretary | Party token in URL: `/api/candidates/party/:partyToken/...` (overview, re-send links, remove candidates — cannot edit answers) |
| Candidate sign-up | Registration token in URL: `/api/candidates/register/:registrationToken` |
| Candidate | Personal token in URL: `/api/candidates/me/:candidateToken/...` |
| Public | No auth required |

---

### Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Health check |

---

### Parties (Admin)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/parties` | List all parties |
| POST | `/api/admin/parties` | Create party — response includes the secret `token` and `registration_token` |
| POST | `/api/admin/parties/:id/token` | Rotate the party token (old party portal link stops working) |
| GET | `/api/admin/parties/:id/candidates` | Party's candidates **with** their personal tokens — for handing a link over by hand |
| POST | `/api/admin/parties/:id/send-candidate-links` | Email every candidate of the party their personal link (202, sent in the background; 503 without SMTP) |
| DELETE | `/api/admin/parties/:id` | Delete party |

```json
// POST body
{ "name": "Puolueen nimi", "email": "sihteeri@puolue.fi" }
```

---

### Question Sets

A *question set* is one organization's themed bundle of statements — the core unit of the multi-NGO model. Submission is public (any NGO, no account); visibility is gated on admin approval.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/question-sets` | None | Approved sets + questions (the union voters choose from) |
| POST | `/api/question-sets` | None | NGO submits a set (→ pending) |
| GET | `/api/admin/question-sets` | Admin | All sets (any status) |
| PATCH | `/api/admin/question-sets/:id/approve` | Admin | Approve; sends email notifications |
| PATCH | `/api/admin/question-sets/:id/reject` | Admin | Reject |
| PATCH | `/api/admin/question-sets/:id/review` | Admin | Per-question accept/edit/reject; `duplicateOf` merges a question into an existing canonical one |
| POST | `/api/admin/question-sets/merge-questions` | Admin | Merge duplicates retroactively: `{ keepId, dropIds }` |

```json
// POST body (NGO submission)
{
  "ngoName": "Järjestön nimi",
  "ngoEmail": "info@jarjesto.fi",
  "logoUrl": "https://example.com/logo.png",
  "title": "Kysymyssarjan otsikko",
  "questions": ["Väittämä 1", "Väittämä 2"]
}
```

Each entry in `questions` is a string or `{ "statement": "..." }`, at most 50 entries. A statement over 500 characters rejects the submission with a 400 naming it, as does a submission with no non-empty statements. Entries that are blank, or neither a string nor an object with a string `statement`, are skipped **without notice** while the rest are saved. The frontend never sends those. Direct API clients should send only non-empty strings.

---

### Candidates

**Public:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/candidates` | All candidates + party info |
| GET | `/api/candidates/:id` | Single candidate + all answers |

**Party-token gated** (party secretary):

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/candidates/party/:partyToken` | Party info incl. `registrationToken`, candidates with answer counts (never their tokens) |
| POST | `/api/candidates/party/:partyToken/registration-token` | Rotate the registration link |
| POST | `/api/candidates/party/:partyToken/candidates/:id/send-link` | Email the candidate their personal link (to their own address) |
| DELETE | `/api/candidates/party/:partyToken/candidates/:id` | Remove a candidate |

**Registration-token gated** (self-registration; candidates are visible to voters immediately):

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/candidates/register/:registrationToken` | Party name |
| POST | `/api/candidates/register/:registrationToken` | Register — returns the candidate incl. personal `token`, also emailed. Same name + email again → 409 and the existing link is re-sent |

**Candidate-token gated** (the candidate's personal link):

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/candidates/me/:candidateToken` | Own profile, party and answers |
| PUT | `/api/candidates/me/:candidateToken` | Update own profile (full replace); an optional `answers` field (same shape as below) is saved in the same transaction, and the response then also carries `saved` and `skipped` |
| PUT | `/api/candidates/me/:candidateToken/answers` | Save own answers (upsert) |

```json
// POST/PUT body (profile) — name, email and constituency required
{ "name": "Matti Meikäläinen", "email": "matti@example.fi", "constituency": "Helsingin vaalipiiri", "photoUrl": "...", "bio": "..." }

// PUT body (answers)
{
  "answers": {
    "question-uuid": { "value": 3, "explanation": "Perustelut..." }
  }
}
```

Saving answers is all-or-nothing: an invalid `value` (integer 0–4) or an `explanation` over 500 characters rejects the whole request with a 400 naming the question(s). Answers for questions that no longer exist (merged or deleted) are skipped, and the response lists their keys: `{ "saved": 2, "skipped": ["question-uuid"] }`.

Question UUID keys must be **lowercase**, as the API returns them. An uppercase key doesn't match the database ID, so that answer is reported in `skipped` even though the question exists. The frontend always sends lowercase. Direct API clients must too, until keys are normalised server-side.

---

### Voter Match

| Method | Path | Auth | Rate limit |
|--------|------|------|------------|
| POST | `/api/voter/match` | None | 300 / min (`RATE_LIMIT_MATCH_MAX`) |

```json
// Request
{
  "answers": { "question-uuid": 4 },
  "weights": { "question-uuid": 3 },
  "questionSetIds": ["set-uuid"],
  "sessionId": "session-uuid"
}
```

- `answers` — voter values 0–4 per question UUID (required)
- `weights` — importance weights 0–3 per question UUID (optional, default 1)
- `questionSetIds` — restrict to specific sets (optional). Only the voter's answers to questions in these sets are scored.
- `sessionId` — key for the anonymous research rows (optional; generated server-side if absent). Send a fresh UUID per submission and resend the same one when retrying, so a retry after a lost response stores no second session.

Question UUIDs in `answers` and `weights` must be **lowercase**, as the API returns them, and direct clients should always send `questionSetIds`. See [docs/direct-api-caveats.md](docs/direct-api-caveats.md) for what happens otherwise. That file lists all API behaviour the frontend never triggers but direct API clients can.

**Match algorithm:** For each question the voter answered:
```
similarity = 1 - |voterValue - candidateValue| / 4   (0 if the candidate skipped it)
weighted   = similarity × (weight + 1)
```
The weighted similarities are averaged over all of the voter's questions and returned as a percentage. A skipped question counts as full disagreement, so a candidate cannot reach a high match by answering only a few questions.

**Response:** `{ sessionId, questionCount, results: [...] }`. `questionCount` is the number of the voter's questions that were scored. Results are sorted by `match` descending, then `answeredCount` descending (how many of the `questionCount` questions the candidate answered), then by name. Each result includes the candidate's answers for comparison. The `sessionId` is also used to store voter responses anonymously for analytics. Only the scored questions are stored, so a session is the questionnaire that was matched; answers to sets outside `questionSetIds` are not recorded. It is `null` when the voter opted out of research (`includeInResearch: false`) or none of the voter's questions were scored; otherwise the session is recorded even if no candidate matched.

---

## Frontend

The entire React SPA lives in [vaalikone-frontend/src/App.jsx](vaalikone-frontend/src/App.jsx), apart from the API client in [vaalikone-frontend/src/api.js](vaalikone-frontend/src/api.js). View routing is URL-param based (`?view=...`).

| View | URL | Purpose |
|------|-----|---------|
| Home | `/` | Navigation hub |
| Voter | `?view=voter` | Pick which NGO question sets to use, answer, set weights, view matches |
| Results | (within voter flow) | Candidate match results with comparison |
| Admin | `?view=admin` | Manage parties, approve/reject question sets |
| NGO | `?view=ngo` | Submit a new question set |
| Party portal | `?partyToken=…` | Share registration link, follow progress, re-send links, remove candidates |
| Legacy answer link | `?view=candidate&partyToken=…&candidateId=…` | "Link out of date" page — never opens the party portal |
| Registration | `?register=…` | Candidate self-registration |
| Candidate | `?candidateToken=…` | Candidate edits own profile and answers |

**API client:** All calls go through `apiFetch()` with automatic snake_case → camelCase conversion of response keys; request keys are sent unchanged. It retries once on `502/503/504` or a network error, but only for `GET`s and requests that opt in with `retry: true` (the match POST). The `API_BASE` constant at the top of `App.jsx` defaults to same-origin `/api` (proxied by Vite in development and by nginx in Docker); override it with `VITE_API_BASE` at build time.

**Design:** Source Serif 4 font, forest-green accent (`#2D5A3D`), soft neutral backgrounds. Responsive and mobile-friendly.

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Backend port |
| `NODE_ENV` | `development` | Environment |
| `DATABASE_URL` | — | PostgreSQL connection string |
| `ADMIN_SECRET` | — | Bearer token for admin endpoints |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed frontend origin |
| `ADMIN_EMAIL` | — | Admin address for notifications |
| `SMTP_HOST` | — | SMTP server (leave unset to disable email) |
| `SMTP_PORT` | `1025` | SMTP port |
| `SMTP_SECURE` | `false` | TLS (`true` for port 465) |
| `SMTP_FROM` | `noreply@vaalikone.fi` | Sender address |
| `SMTP_USER` | — | SMTP username (optional) |
| `SMTP_PASS` | — | SMTP password (optional) |
| `RATE_LIMIT_MATCH_MAX` | `300` | Voter match requests per IP per minute (production only) |

In Docker Compose, `mailpit` provides a local SMTP server (port 1025) and web UI at http://localhost:8025, and `CORS_ORIGIN` is overridden to `http://localhost:80` to match the containerized frontend.

---

## Testing

```bash
npm test                # Run all tests
npm run test:watch      # Watch mode
npm run test:coverage   # Coverage report
```

Integration tests use `supertest` and a mock database helper. Unit tests cover auth middleware, validation logic and the frontend API client. `npm test` runs Jest with `--experimental-vm-modules` so tests can `import()` the frontend's ES modules. Running Jest any other way (`npx jest`, an IDE runner) needs the same flag, e.g. `NODE_OPTIONS=--experimental-vm-modules npx jest tests/unit/apiClient.test.js`; without it `apiClient.test.js` fails.

---

## Rate Limiting

| Scope | Limit | Window |
|-------|-------|--------|
| Admin endpoints (requests without a valid admin secret) | 30 req | 15 min |
| NGO submissions | 20 req | 15 min |
| Voter match | 300 req (`RATE_LIMIT_MATCH_MAX`) | 1 min |

These limits, and the per-token limits on the party, registration and candidate links (`src/routes/candidates.js`), apply only when `NODE_ENV=production`; otherwise they are skipped. The voter match default leaves room for many voters behind one carrier CGNAT address; raise `RATE_LIMIT_MATCH_MAX` if they hit 429s, or for load tests (see `docs/scaling.md`). The admin limit only counts requests that lack a valid `ADMIN_SECRET`, so it slows down guessing the secret without throttling a logged-in admin.

---

## Key Conventions

- All error messages and UI text are in **Finnish**
- DB queries use parameterized statements (`$1`, `$2`, …) — no string interpolation
- Admin endpoints: `/api/admin/*` with Bearer token
- Party-gated endpoints: `/api/candidates/party/:partyToken/...`
- Voter responses are stored anonymously (random session UUID, no IP or user data)

---

## License
Copyright (C) Tuukka Pitkänen
Licensed under the **GNU Affero General Public License v3.0** (AGPL-3.0-only). See [LICENSE](LICENSE) for the full text.

Because the AGPL is a network-copyleft license, anyone who runs a modified version of this software as a public service (e.g. a hosted vaalikone) must make the corresponding source code available to its users. If you deploy a fork, offer your source — for example via a "Source" link in the UI — as required by section 13.
