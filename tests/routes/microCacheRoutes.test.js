jest.mock("../../src/db/pool");

const express = require("express");
const request = require("supertest");
const db = require("../../src/db/pool");
const { resetDbMocks } = require("../helpers/mockDb");

// Issue #150: the micro-cache keys on the declared route and lowercases its
// params, which is only safe because the real routes validate the id as a
// UUID before the cache runs. These tests mount the real routers, so a
// reordered or newly cached route shows up here.

const ID = "550e8400-e29b-41d4-a716-446655440000";
const CANDIDATE = { id: ID, name: "Eeva Ehdokas", photo_url: null, bio: null, constituency: "Helsingin vaalipiiri", party_id: "p1", party_name: "Vihreät" };

let app;
let savedEnv;
beforeEach(() => {
  resetDbMocks();
  savedEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  // A fresh module registry gives each test an empty cache.
  jest.isolateModules(() => {
    const candidates = require("../../src/routes/candidates");
    const { publicRouter } = require("../../src/routes/questionSets");
    app = express();
    app.use("/api/candidates", candidates);
    app.use("/api/question-sets", publicRouter);
  });
});
afterEach(() => {
  process.env.NODE_ENV = savedEnv;
});

test("GET /api/candidates ignores unused query parameters", async () => {
  db.query.mockResolvedValueOnce({ rows: [CANDIDATE] });

  for (let i = 0; i < 5; i++) {
    const res = await request(app).get(`/api/candidates?unused=${i}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  }
  expect(db.query).toHaveBeenCalledTimes(1);
});

test("GET /api/candidates/:id shares an entry across id case and query", async () => {
  db.query
    .mockResolvedValueOnce({ rows: [CANDIDATE] })
    .mockResolvedValueOnce({ rows: [] });

  for (const path of [`/api/candidates/${ID}`, `/api/candidates/${ID.toUpperCase()}`, `/api/candidates/${ID}?x=1`]) {
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(ID);
  }
  expect(db.query).toHaveBeenCalledTimes(2); // candidate + answers, once
});

test("GET /api/candidates/:id rejects a non-UUID before the cache", async () => {
  expect((await request(app).get("/api/candidates/not-a-uuid")).status).toBe(400);
  expect(db.query).not.toHaveBeenCalled();
});

test("GET /api/question-sets ignores unused query parameters", async () => {
  db.query.mockResolvedValue({ rows: [] });

  for (let i = 0; i < 5; i++) {
    expect((await request(app).get(`/api/question-sets?unused=${i}`)).status).toBe(200);
  }
  const calls = db.query.mock.calls.length;
  await request(app).get("/api/question-sets?unused=again");
  expect(db.query.mock.calls.length).toBe(calls);
  expect(calls).toBeGreaterThan(0);
});
