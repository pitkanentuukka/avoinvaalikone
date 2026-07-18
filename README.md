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

Candidates, in turn, answer the pooled approved questions (via a per-party link) so that whatever combination a voter picks, there are candidate answers to match against.

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
│   │   ├── auth.js           # requireAdmin (timing-safe Bearer), requirePartyToken
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
│   └── unit/                 # Unit tests (auth, validation)
├── vaalikone-frontend/
│   ├── src/
│   │   ├── App.jsx           # Entire SPA — views, components, API client
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
| **parties** | id, name, token, email | `token` is shared with party secretaries |
| **candidates** | id, party_id, name, photo_url, bio, email | Linked to a party |
| **candidate_answers** | candidate_id, question_id, value (0–4), explanation | Unique per candidate+question |
| **question_sets** | id, ngo_name, ngo_email, title, status, hidden | `status`: `pending \| approved \| rejected` |
| **questions** | id, statement | Canonical question; may belong to several sets |
| **question_set_questions** | question_set_id, question_id, sort_order | Join table (a question ↔ many sets, per-set ordering) |
| **voter_responses** | session_id, question_id, value, weight | Anonymous analytics (no PII) |

All primary keys are UUIDs (`gen_random_uuid()`). New migrations should follow the versioned pattern and update `schema_migrations`.

---

## API Reference

### Authentication

| Type | Mechanism |
|------|-----------|
| Admin | `Authorization: Bearer <ADMIN_SECRET>` header |
| Party writes | Party token in URL: `/api/candidates/party/:partyToken/...` |
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
| POST | `/api/admin/parties` | Create party — response includes the secret `token` |
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

---

### Candidates

**Public:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/candidates` | All candidates + party info |
| GET | `/api/candidates/:id` | Single candidate + all answers |

**Party-token gated:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/candidates/party/:partyToken` | Party's candidates |
| POST | `/api/candidates/party/:partyToken` | Register new candidate |
| PUT | `/api/candidates/party/:partyToken/candidates/:id` | Update profile |
| PUT | `/api/candidates/party/:partyToken/candidates/:id/answers` | Save answers (upsert) |

```json
// POST body (new candidate)
{ "name": "Matti Meikäläinen", "email": "matti@example.fi", "photoUrl": "...", "bio": "..." }

// PUT body (answers)
{
  "answers": {
    "question-uuid": { "value": 3, "explanation": "Perustelut..." }
  }
}
```

---

### Voter Match

| Method | Path | Auth | Rate limit |
|--------|------|------|------------|
| POST | `/api/voter/match` | None | 60 / min |

```json
// Request
{
  "answers": { "question-uuid": 4 },
  "weights": { "question-uuid": 3 },
  "questionSetIds": ["set-uuid"]
}
```

- `answers` — voter values 0–4 per question UUID (required)
- `weights` — importance weights 0–3 per question UUID (optional, default 1)
- `questionSetIds` — restrict to specific sets (optional)

**Match algorithm:** For each overlapping question:
```
similarity = 1 - |voterValue - candidateValue| / 4
weighted   = similarity × (weight + 1)
```
Scores are averaged across all overlapping questions and returned as a percentage.

**Response:** `{ sessionId, results: [...] }` — candidates sorted by `match` descending, each with their answers for comparison. The `sessionId` is also used to anonymously store voter responses for analytics.

---

## Frontend

The entire React SPA lives in [vaalikone-frontend/src/App.jsx](vaalikone-frontend/src/App.jsx). View routing is URL-param based (`?view=...`).

| View | URL | Purpose |
|------|-----|---------|
| Home | `/` | Navigation hub |
| Voter | `?view=voter` | Pick which NGO question sets to use, answer, set weights, view matches |
| Results | (within voter flow) | Candidate match results with comparison |
| Admin | `?view=admin` | Manage parties, approve/reject question sets |
| NGO | `?view=ngo` | Submit a new question set |
| Candidate | `?view=candidate&partyToken=…` | Register/edit profile and submit answers |

**API client:** All calls go through `apiFetch()` with automatic snake_case ↔ camelCase conversion. The `API_BASE` constant at the top of `App.jsx` points to `http://localhost:3000/api` — update this for non-local deployments.

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

In Docker Compose, `mailpit` provides a local SMTP server (port 1025) and web UI at http://localhost:8025, and `CORS_ORIGIN` is overridden to `http://localhost:80` to match the containerized frontend.

---

## Testing

```bash
npm test                # Run all tests
npm run test:watch      # Watch mode
npm run test:coverage   # Coverage report
```

Integration tests use `supertest` and a mock database helper. Unit tests cover auth middleware and validation logic.

---

## Rate Limiting

| Scope | Limit | Window |
|-------|-------|--------|
| Admin endpoints | 30 req | 15 min |
| NGO submissions | 20 req | 15 min |
| Voter match | 60 req | 1 min |

Rate limiting is skipped in development (`NODE_ENV=development`) for admin endpoints.

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
