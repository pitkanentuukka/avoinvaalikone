# Vaalikone 2026 — Backend API

Node/Express + PostgreSQL backend for the voter advisory machine.

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Create your .env from the template
cp .env.example .env
# Edit .env with your PostgreSQL connection string and admin secret

# 3. Create the database
createdb vaalikone

# 4. Run migrations
npm run migrate

# 5. (Optional) Seed with sample data
npm run seed

# 6. Start the server
npm run dev
```

## Architecture

```
src/
├── index.js              # Express app entry point
├── db/
│   └── pool.js           # PostgreSQL connection pool
├── middleware/
│   └── auth.js           # Admin + party-token auth
└── routes/
    ├── parties.js        # Admin: manage parties
    ├── questionSets.js   # NGO submission + admin approval
    ├── candidates.js     # Candidate registration + answers
    └── voter.js          # Match computation
```

## API Reference

### Authentication

- **Admin endpoints** require `Authorization: Bearer <ADMIN_SECRET>` header.
- **Candidate write endpoints** are gated by party token in the URL path (`/api/candidates/party/:partyToken/...`).
- **Public endpoints** (voter, question set listing) require no auth.

---

### Health

| Method | Path          | Auth  | Description    |
|--------|---------------|-------|----------------|
| GET    | /api/health   | None  | Health check   |

---

### Parties (Admin)

| Method | Path                    | Auth  | Description         |
|--------|-------------------------|-------|---------------------|
| GET    | /api/admin/parties      | Admin | List all parties    |
| POST   | /api/admin/parties      | Admin | Create a party      |
| DELETE | /api/admin/parties/:id  | Admin | Delete a party      |

**POST body:**
```json
{ "name": "Puolueen nimi", "email": "sihteeri@puolue.fi" }
```

**Response** includes the auto-generated `token` to share with the party secretary.

---

### Question Sets

| Method | Path                                       | Auth  | Description                  |
|--------|--------------------------------------------|-------|------------------------------|
| GET    | /api/question-sets                         | None  | List approved sets + questions |
| POST   | /api/question-sets                         | None  | NGO submits a new set (→ pending) |
| GET    | /api/question-sets/admin                   | Admin | List ALL sets (any status)   |
| PATCH  | /api/question-sets/admin/:id/approve       | Admin | Approve a set                |
| PATCH  | /api/question-sets/admin/:id/reject        | Admin | Reject a set                 |

**POST body (NGO submission):**
```json
{
  "ngoName": "Järjestön nimi",
  "ngoEmail": "info@jarjesto.fi",
  "logoUrl": "https://example.com/logo.png",
  "title": "Kysymyssarjan otsikko",
  "questions": [
    "Väittämä 1",
    "Väittämä 2"
  ]
}
```

---

### Candidates

**Public:**

| Method | Path                  | Auth  | Description                      |
|--------|-----------------------|-------|----------------------------------|
| GET    | /api/candidates       | None  | List all candidates + party info |
| GET    | /api/candidates/:id   | None  | Single candidate + all answers   |

**Party-token gated:**

| Method | Path                                                   | Auth        | Description              |
|--------|--------------------------------------------------------|-------------|--------------------------|
| GET    | /api/candidates/party/:partyToken                      | Party token | List party's candidates  |
| POST   | /api/candidates/party/:partyToken                      | Party token | Register new candidate   |
| PUT    | /api/candidates/party/:partyToken/candidates/:id       | Party token | Update profile           |
| PUT    | /api/candidates/party/:partyToken/candidates/:id/answers | Party token | Save answers (upsert)   |

**POST body (new candidate):**
```json
{
  "name": "Matti Meikäläinen",
  "photoUrl": "https://example.com/photo.jpg",
  "bio": "Esittelyteksti..."
}
```

**PUT body (answers):**
```json
{
  "answers": {
    "question-uuid-1": { "value": 3, "explanation": "Perustelut..." },
    "question-uuid-2": { "value": 1, "explanation": "" }
  }
}
```

---

### Voter

| Method | Path              | Auth | Description                    |
|--------|-------------------|------|--------------------------------|
| POST   | /api/voter/match  | None | Compute candidate match scores |

**POST body:**
```json
{
  "answers": {
    "question-uuid-1": 4,
    "question-uuid-2": 1,
    "question-uuid-3": 3
  },
  "weights": {
    "question-uuid-1": 3,
    "question-uuid-2": 0
  },
  "questionSetIds": ["set-uuid-1", "set-uuid-2"]
}
```

- `answers` — voter's answer values (0–4), keyed by question UUID. **Required.**
- `weights` — importance weights (0–3), keyed by question UUID. Optional, defaults to 1.
- `questionSetIds` — restrict matching to specific sets. Optional.

**Response:** Array of candidates sorted by `match` percentage (descending), each including their answers for comparison.

---

## Database Schema

- **parties** — political parties with unique URL tokens
- **question_sets** — NGO-submitted question sets with approval workflow
- **questions** — individual policy statements within a set
- **candidates** — candidate profiles linked to a party
- **candidate_answers** — each candidate's answer (0–4) + explanation per question

## Environment Variables

| Variable       | Description                          | Default                          |
|----------------|--------------------------------------|----------------------------------|
| PORT           | Server port                          | 3000                             |
| DATABASE_URL   | PostgreSQL connection string         | —                                |
| ADMIN_SECRET   | Bearer token for admin endpoints     | —                                |
| CORS_ORIGIN    | Allowed frontend origin              | http://localhost:5173             |
| NODE_ENV       | Environment                          | development                      |
