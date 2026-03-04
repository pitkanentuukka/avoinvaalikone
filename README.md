# Vaalikone 2026

Finnish voter advisory machine (election compass). Voters answer policy questions and are matched with candidates based on weighted answer similarity.

**Stack:** Node.js + Express + PostgreSQL (backend) · React 19 + Vite (frontend) · Docker Compose (full stack)

---

## Quick Start

### Docker (recommended)

```bash
docker compose up --build
```

| Service  | URL                        |
|----------|----------------------------|
| Frontend | http://localhost:8080      |
| Backend  | http://localhost:3000      |
| Mailpit  | http://localhost:8025      |

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
| **question_sets** | id, ngo_name, ngo_email, title, status | `status`: `pending \| approved \| rejected` |
| **questions** | id, question_set_id, statement, sort_order | Belongs to a question set |
| **voter_responses** | session_id, question_id, value, answered_on | Anonymous analytics (no PII) |

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

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/question-sets` | None | Approved sets + questions |
| POST | `/api/question-sets` | None | NGO submits a set (→ pending) |
| GET | `/api/admin/question-sets` | Admin | All sets (any status) |
| PATCH | `/api/admin/question-sets/:id/approve` | Admin | Approve; sends email notifications |
| PATCH | `/api/admin/question-sets/:id/reject` | Admin | Reject |

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
| Voter | `?view=voter` | Answer questions, set weights, view matches |
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

In Docker Compose, `mailpit` provides a local SMTP server (port 1025) and web UI at http://localhost:8025.

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
