# Vaalikone Use Cases

This document describes all use cases for end-to-end testing, organized by user category.

---

## 1. NGO (Non-Governmental Organization)

NGOs submit question sets for candidates to answer. They interact via the public submission form.

### UC-NGO-1: Submit a Question Set

**Actor:** NGO representative
**Endpoint:** `POST /api/question-sets`
**Preconditions:** None (public endpoint)

**Main Flow:**
1. NGO fills in organization name, title, and a list of question statements
2. Optionally provides email, logo URL
3. System validates input and creates a question set with status `pending`
4. System sends an admin notification email (fire-and-forget)
5. Returns created question set with questions

**Edge Cases:**
- Missing `ngoName` or `title` -> 400
- Empty `questions` array or not an array -> 400
- More than 50 questions -> 400
- `ngoName` exceeds 255 characters -> 400
- `title` exceeds 255 characters -> 400
- `ngoEmail` exceeds 255 characters or invalid format -> 400
- `logoUrl` exceeds 500 characters or not http(s) -> 400
- Individual question statement exceeds 500 characters -> silently skipped
- Question is not a string or is empty -> silently skipped
- Questions can be passed as strings or `{ statement: "..." }` objects
- Rate limited: 20 requests per 15 minutes

### UC-NGO-2: View Approved Question Sets

**Actor:** NGO representative (or any public user)
**Endpoint:** `GET /api/question-sets`
**Preconditions:** At least one question set has been approved

**Main Flow:**
1. System returns all question sets with status `approved`, each including their questions
2. Sets are ordered by `submitted_at`

**Edge Cases:**
- No approved sets exist -> returns empty array
- Questions within each set are ordered by `sort_order`

---

## 2. Voter

Voters answer questions and get matched with candidates.

### UC-VOTER-1: Take the Quiz and Get Match Results

**Actor:** Voter
**Endpoint:** `POST /api/voter/match`
**Preconditions:**
- At least one question set is approved with questions
- At least one candidate has answered those questions

**Main Flow:**
1. Voter answers questions (values 0-4) and optionally sets weights (0-3)
2. Optionally filters by specific question set IDs
3. System computes weighted similarity scores for each candidate
4. System stores anonymous voter responses (server-generated session UUID)
5. Returns `sessionId` and candidates sorted by match percentage descending

**Match Algorithm:**
- For each overlapping question: `similarity = 1 - |voterValue - candidateValue| / 4`
- Weight factor: `weight + 1` (weight 0 -> factor 1, weight 3 -> factor 4)
- Final score: `weightedScore / totalWeight * 100`, rounded

**Edge Cases:**
- Missing or empty `answers` object -> 400
- Answer values outside 0-4 range -> 400
- Weight values outside 0-3 range -> 400
- Non-UUID question IDs in answers -> 400
- Non-UUID question set IDs in `questionSetIds` -> 400
- Number of answers exceeds total question count in DB -> 400
- No candidates have answered any of the voter's questions -> returns empty array
- Candidate has only answered some of the voter's questions -> match computed on overlapping questions only
- All voter answers match a candidate perfectly -> 100% match
- All voter answers are maximally different from candidate -> 0% match (value diff = 4)
- Weights default to 0 if not provided
- Rate limited: 60 requests per 1 minute
- Voter responses are stored with a random session UUID (no identity link)

### UC-VOTER-2: View All Candidates

**Actor:** Voter
**Endpoint:** `GET /api/candidates`
**Preconditions:** At least one candidate exists

**Main Flow:**
1. Returns all candidates with party info, ordered by party name then candidate name

**Edge Cases:**
- No candidates exist -> returns empty array

### UC-VOTER-3: View Single Candidate with Answers

**Actor:** Voter
**Endpoint:** `GET /api/candidates/:id`
**Preconditions:** Candidate exists

**Main Flow:**
1. Returns candidate profile (name, photo, bio, party info) with all their answers keyed by question ID

**Edge Cases:**
- Invalid UUID format for `:id` -> 400
- Candidate not found -> 404
- Candidate has no answers -> returns empty `answers` object

---

## 3. Candidate (via Party Token)

Candidates are managed through party-token-gated endpoints. A party token is a URL slug generated when the admin creates a party.

### UC-CAND-1: View Party's Candidates

**Actor:** Party admin / candidate
**Endpoint:** `GET /api/candidates/party/:partyToken`
**Preconditions:** Valid party token exists

**Main Flow:**
1. Returns party info and list of candidates belonging to the party
2. Each candidate includes their `answer_count`

**Edge Cases:**
- Invalid or non-existent party token -> 404
- Party has no candidates -> returns empty `candidates` array

### UC-CAND-2: Register a New Candidate

**Actor:** Party admin
**Endpoint:** `POST /api/candidates/party/:partyToken`
**Preconditions:** Valid party token exists

**Main Flow:**
1. Provide candidate `name`, optionally `photoUrl`, `bio`, `email`
2. System creates candidate linked to the party

**Edge Cases:**
- Missing `name` -> 400
- `name` exceeds 255 characters -> 400
- `photoUrl` exceeds 500 characters or not http(s) -> 400
- `bio` exceeds 1000 characters -> 400
- `email` exceeds 255 characters or invalid format -> 400
- Invalid party token -> 404

### UC-CAND-3: Update Candidate Profile

**Actor:** Party admin / candidate
**Endpoint:** `PUT /api/candidates/party/:partyToken/candidates/:id`
**Preconditions:**
- Valid party token
- Candidate exists and belongs to the party

**Main Flow:**
1. Update `name`, `photoUrl`, `bio` for the candidate
2. `name` uses COALESCE (only updates if provided), `photoUrl` and `bio` are set directly (can be nulled)

**Edge Cases:**
- Invalid UUID for `:id` -> 400
- Candidate does not belong to this party -> 404
- Candidate not found -> 404
- `name` exceeds 255 characters -> 400
- `photoUrl` exceeds 500 characters or not http(s) -> 400
- `bio` exceeds 1000 characters -> 400
- Sending `null`/empty `photoUrl` or `bio` clears the field

### UC-CAND-4: Save Candidate Answers

**Actor:** Party admin / candidate
**Endpoint:** `PUT /api/candidates/party/:partyToken/candidates/:id/answers`
**Preconditions:**
- Valid party token
- Candidate exists and belongs to the party
- Questions exist (from approved question sets)

**Main Flow:**
1. Submit `answers` object: `{ [questionId]: { value: 0-4, explanation?: string } }`
2. Answers are upserted (insert or update on conflict)
3. Candidate's `updated_at` timestamp is refreshed
4. Returns count of saved answers

**Edge Cases:**
- Missing or non-object `answers` -> 400
- Candidate does not belong to this party -> 404
- Invalid UUID question IDs -> silently skipped
- Answer value outside 0-4 or non-numeric -> silently skipped
- Explanation exceeds 500 characters -> silently skipped
- Empty explanation -> stored as empty string
- Re-submitting answers for the same questions -> updates existing (upsert)
- Transaction: all-or-nothing (rolls back on error)
- Invalid party token -> 404

---

## 4. Admin

Admins manage parties and moderate question sets. All admin endpoints require `Authorization: Bearer <ADMIN_SECRET>` header.

### UC-ADMIN-1: List All Parties

**Actor:** Admin
**Endpoint:** `GET /api/admin/parties`
**Preconditions:** Valid admin token

**Main Flow:**
1. Returns all parties with `id`, `name`, `token`, `email`, `created_at`
2. Ordered by `created_at`

**Edge Cases:**
- No parties exist -> returns empty array
- Missing or invalid admin token -> 401 / 403

### UC-ADMIN-2: Create a Party

**Actor:** Admin
**Endpoint:** `POST /api/admin/parties`
**Preconditions:** Valid admin token

**Main Flow:**
1. Provide party `name` and optionally `email`
2. System generates a URL-safe token from the name (slugified + UUID fragment)
3. Returns created party with token

**Edge Cases:**
- Missing `name` -> 400
- `name` exceeds 100 characters -> 400
- `email` exceeds 255 characters or invalid format -> 400
- Duplicate party name -> 409 (unique constraint on `name`)
- Token is auto-generated and unique
- Missing or invalid admin token -> 401 / 403
- Rate limited: 30 requests per 15 minutes (production only)

### UC-ADMIN-3: Delete a Party

**Actor:** Admin
**Endpoint:** `DELETE /api/admin/parties/:id`
**Preconditions:** Valid admin token, party exists

**Main Flow:**
1. Deletes the party by UUID
2. Cascades: deletes all candidates and their answers

**Edge Cases:**
- Invalid UUID for `:id` -> 400
- Party not found -> 404
- Missing or invalid admin token -> 401 / 403
- Cascade deletion removes all associated candidates and candidate_answers

### UC-ADMIN-4: List All Question Sets (Any Status)

**Actor:** Admin
**Endpoint:** `GET /api/admin/question-sets`
**Preconditions:** Valid admin token

**Main Flow:**
1. Returns all question sets (pending, approved, rejected) with their questions
2. Ordered: pending first, then approved, then rejected; within each group by `submitted_at`

**Edge Cases:**
- No question sets exist -> returns empty array
- Missing or invalid admin token -> 401 / 403

### UC-ADMIN-5: Approve a Question Set

**Actor:** Admin
**Endpoint:** `PATCH /api/admin/question-sets/:id/approve`
**Preconditions:**
- Valid admin token
- Question set exists

**Main Flow:**
1. Sets status to `approved`, sets `reviewed_at` to now
2. Sends notification email to the NGO (fire-and-forget)
3. Sends notification emails to all candidates and parties that have existing answers (fire-and-forget)

**Edge Cases:**
- Invalid UUID for `:id` -> 400
- Question set not found -> 404
- Approving an already approved set -> succeeds (idempotent, updates `reviewed_at`)
- Approving a rejected set -> succeeds (changes status to approved)
- Email sending failure does not affect the response
- Missing or invalid admin token -> 401 / 403

### UC-ADMIN-6: Reject a Question Set

**Actor:** Admin
**Endpoint:** `PATCH /api/admin/question-sets/:id/reject`
**Preconditions:**
- Valid admin token
- Question set exists

**Main Flow:**
1. Sets status to `rejected`, sets `reviewed_at` to now
2. Sends notification email to the NGO (fire-and-forget)

**Edge Cases:**
- Invalid UUID for `:id` -> 400
- Question set not found -> 404
- Rejecting an already rejected set -> succeeds (idempotent)
- Rejecting an approved set -> succeeds (changes status to rejected)
- Email sending failure does not affect the response
- Missing or invalid admin token -> 401 / 403

---

## 5. Cross-Cutting Concerns

These apply across all user categories and should be tested as part of E2E scenarios.

### CC-1: Authentication & Authorization

- Admin endpoints without `Authorization` header -> 401
- Admin endpoints with wrong Bearer token -> 403
- Party-token endpoints with non-existent token -> 404
- Timing-safe comparison prevents timing attacks on admin secret

### CC-2: Rate Limiting

- Admin endpoints: 30 req / 15 min (skipped in non-production)
- NGO submission: 20 req / 15 min
- Voter match: 60 req / 1 min
- Exceeding limits -> 429 with Finnish error message

### CC-3: Input Validation

- Invalid UUID route params -> 400
- Field length violations -> 400
- URL fields must start with `http://` or `https://`
- Email format validation
- Answer values must be integers 0-4
- Weight values must be integers 0-3
- JSON body size limited to 1 MB

### CC-4: Error Handling

- Non-existent routes -> 404 with `"Reittiä ei löytynyt"`
- Unhandled errors -> 500 with `"Palvelinvirhe"` (production) or error message (development)
- All error messages are in Finnish

### CC-5: CORS & Security

- CORS restricted to configured origin (default `http://localhost:5173`)
- Helmet security headers enabled
- HSTS with 1-year max-age, includeSubDomains, preload
- HTTP -> HTTPS redirect in production (requires `PUBLIC_HOST` env var)

### CC-6: Database Integrity

- All primary keys are auto-generated UUIDs
- Unique constraints: `parties.name`, `parties.token`, `(candidate_id, question_id)` in answers
- Foreign key cascades: deleting a party cascades to candidates and answers; deleting a question set cascades to questions; deleting a question cascades to candidate_answers and voter_responses
- Transactions used for multi-table writes (question set submission, candidate answer saving)

---

## 6. End-to-End Workflow Scenarios

### E2E-1: Full Lifecycle — From Question Creation to Voter Match

1. **Admin** creates a party (UC-ADMIN-2)
2. **NGO** submits a question set (UC-NGO-1) — status is `pending`
3. **Admin** approves the question set (UC-ADMIN-5) — status becomes `approved`
4. **Candidate** registers via party token (UC-CAND-2)
5. **Candidate** answers the approved questions (UC-CAND-4)
6. **Voter** views approved question sets (UC-NGO-2) to see available questions
7. **Voter** submits answers and gets match results (UC-VOTER-1)
8. **Voter** views a specific candidate's full profile (UC-VOTER-3)

### E2E-2: Multiple Parties and Candidates

1. Admin creates multiple parties
2. Each party registers multiple candidates
3. Candidates answer overlapping and non-overlapping questions
4. Voter matches against all candidates and verifies ranking order

### E2E-3: Question Set Rejection Flow

1. NGO submits a question set
2. Admin rejects it
3. Verify it does not appear in public `GET /api/question-sets`
4. NGO submits a corrected question set
5. Admin approves the corrected set

### E2E-4: Candidate Answer Update Flow

1. Candidate saves initial answers
2. Candidate updates answers for the same questions (upsert)
3. Voter matches and results reflect updated answers

### E2E-5: Party Deletion Cascade

1. Admin creates a party, registers candidates, candidates answer questions
2. Admin deletes the party
3. Verify candidates and their answers are removed
4. Voter match no longer returns deleted candidates

### E2E-6: Weight Impact on Match Results

1. Two candidates with different answer profiles
2. Voter answers with default weights -> verify ranking
3. Voter answers with high weight on a question where candidate B is closer -> verify ranking changes

### E2E-7: Edge Case — No Overlapping Answers

1. Candidate only answers questions from set A
2. Voter only answers questions from set B
3. Voter match returns 0% or candidate is excluded from results
