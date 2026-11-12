# Direct API caveats

Known API behaviour that only matters to clients calling the API directly. The
frontend never triggers it, so it is documented here rather than fixed for now.
Revisit this list before opening the API to direct users, such as other voter
advisory front-ends, researchers or party tooling.

Each entry lists the affected endpoints, what happens, why the frontend is
unaffected, and what a fix would look like.

## Question UUID keys must be lowercase

**Endpoints:** `POST /api/voter/match` (`answers`, `weights`),
`PUT /api/candidates/me/:candidateToken/answers` (`answers`)

Validation accepts UUIDs in any case, but the routes look answers up by the
lowercase ID the database returns.

- **Match:** an uppercase key is silently left out of scoring and out of
  `questionCount`. An uppercase `answers` key also makes that request's research
  insert into `voter_responses` fail.
- **Candidate answers:** an answer under an uppercase key is not saved. It is
  only visible as a lower `saved` count.

**Why the frontend is unaffected:** it always sends IDs exactly as the API
returned them.

**Fix:** normalise keys to lowercase on the way in.

## NGO submissions skip malformed entries without notice

**Endpoint:** `POST /api/question-sets`

Entries in `questions` that are blank, or neither a string nor an object with a
string `statement`, are dropped. The rest of the set is saved, and the response
doesn't mention what was dropped.

**Why the frontend is unaffected:** it never sends such entries.

**Fix:** reject the submission with a 400 that names the offending entry.
Over-long statements, which the frontend can send, are handled separately in
#2.

## Without `questionSetIds`, unpublished questions are scored

**Endpoint:** `POST /api/voter/match`

When the request has no `questionSetIds`, every question in `answers` that
exists in the database is scored. That includes questions that belong only to
hidden, pending or rejected sets. With `questionSetIds`, the membership check
doesn't look at set status or visibility either. A question the voter answered
but a candidate skipped counts as full disagreement, so each such question
lowers every candidate's match. Candidates can't see unpublished questions, so
almost none of them will have answered one.

**Why the frontend is unaffected:** it always sends `questionSetIds`. On load it
filters the saved selection against the public list (`GET /api/question-sets`,
approved and visible only). A set hidden while a voter is mid-questionnaire is
the one window where the frontend can hit this.

**Fix:** score only questions in at least one approved, visible set, whether or
not `questionSetIds` is given.

## A reused match `sessionId` merges submissions

**Endpoint:** `POST /api/voter/match` (`sessionId`)

The research insert is `ON CONFLICT DO NOTHING` on `(session_id, question_id)`.
A client that sends the same `sessionId` with different answers gets one
research session: answers to questions already stored under that id are
silently dropped, and answers to new questions are added to it.

**Why the frontend is unaffected:** it generates a fresh `sessionId` for every
submission and reuses it only for the one retry of that same request.

**Fix:** none needed for retries. If direct clients need it, reject a
`sessionId` that already has rows with different answers.

## The match `sessionId` stored for research is client-chosen

**Endpoint:** `POST /api/voter/match` (`sessionId`)

`voter_responses.session_id` is stored exactly as the client sent it. Before
#7 it was always server-random (the `migrations/005` header still says so). A
client could pick ids that encode an identifier, or reuse one id per device,
and so link research rows to a person or device. Clients already learned the
server-random id from the response and could record it, so what changed is
control over the id, not knowledge of it.

**Why the frontend is unaffected:** it generates a fresh UUID for each
submission with `crypto.randomUUID()`, never persists it, and reuses it only for
the one retry of that request. So the voter-facing promise that research rows
aren't linked to the browser still holds.

**Fix:** store a keyed hash of the client id, such as an HMAC under a server
secret shared by all replicas. Retries would still collide, but the stored key
would be neither client-chosen nor client-known.

## Non-integer match answers and weights are truncated

**Endpoint:** `POST /api/voter/match` (`answers`, `weights`)

`isValidRange` checks `parseInt(value, 10)`, not the value itself, and scoring
and the research insert read values the same way. So a non-integer is accepted
and silently cut down: `2.9` and `"2abc"` count as 2, `[3]` as 3, `"0x3"` as 0,
and `-0.5` as 0. A string of digits such as `"2"` is read as its number.

**Why the frontend is unaffected:** answers and weights come from the index of
the button the voter clicked, so it only ever sends integers 0–4 and 0–3, and
the copy it saves in localStorage keeps them as such.

**Fix:** require `Number.isInteger(value)` in range, as
`PUT /api/candidates/me/:candidateToken/answers` already does. Decide first
whether to keep accepting digit strings.
