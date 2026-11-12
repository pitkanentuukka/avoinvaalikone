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
