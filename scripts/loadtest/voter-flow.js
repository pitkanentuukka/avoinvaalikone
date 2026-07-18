// k6 load test simulating the real voter flow:
//   GET /api/question-sets -> think -> POST /api/voter/match -> expand 2 candidates.
// Run: k6 run -e BASE_URL=http://localhost scripts/loadtest/voter-flow.js
// See README.md in this directory before running against anything non-local.
import http from "k6/http";
import { check, sleep } from "k6";

const BASE = __ENV.BASE_URL || "http://localhost";

export const options = {
  scenarios: {
    voter_flow: {
      executor: "ramping-arrival-rate",
      startRate: 5,
      timeUnit: "1s",
      preAllocatedVUs: 300,
      maxVUs: 1500,
      // ~4 HTTP requests per iteration -> 125 iter/s ~= 500 req/s at peak
      stages: [
        { duration: "2m", target: 50 },
        { duration: "3m", target: 125 },
        { duration: "3m", target: 125 },
        { duration: "1m", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{endpoint:question-sets}": ["p(95)<300"],
    "http_req_duration{endpoint:match}": ["p(95)<800"],
    "http_req_duration{endpoint:candidate}": ["p(95)<300"],
  },
};

export default function () {
  const qsRes = http.get(`${BASE}/api/question-sets`, {
    tags: { endpoint: "question-sets" },
  });
  check(qsRes, { "question-sets 200": (r) => r.status === 200 });
  const sets = qsRes.json();
  if (!Array.isArray(sets) || sets.length === 0) return;

  const answers = {};
  const weights = {};
  for (const s of sets) {
    for (const q of s.questions || []) {
      answers[q.id] = Math.floor(Math.random() * 5);
      if (Math.random() < 0.3) weights[q.id] = Math.floor(Math.random() * 4);
    }
  }

  // Compressed think time; real voters take minutes, but arrival rate is what
  // matters for load - this just spreads the POSTs off the GET burst.
  sleep(2 + Math.random() * 6);

  const matchRes = http.post(
    `${BASE}/api/voter/match`,
    JSON.stringify({
      answers,
      weights,
      questionSetIds: sets.map((s) => s.id),
      includeInResearch: true,
    }),
    {
      headers: { "Content-Type": "application/json" },
      tags: { endpoint: "match" },
    }
  );
  check(matchRes, { "match 200": (r) => r.status === 200 });
  if (matchRes.status !== 200) return;

  const results = matchRes.json("results") || [];
  for (const c of results.slice(0, 2)) {
    sleep(1 + Math.random() * 2);
    http.get(`${BASE}/api/candidates/${c.id}`, {
      tags: { endpoint: "candidate" },
    });
  }
}
