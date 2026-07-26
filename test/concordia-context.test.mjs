import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadConcordiaContext,
  loadPersistedConcordiaContext,
} from "../src/concordia-context.mjs";

test("reads live Concordia context", async () => {
  const context = await loadConcordiaContext({
    baseUrl: "http://127.0.0.1:11111",
    repository: "LUDIARS/Revisor",
    headRef: "feat/review",
    transport: async () => ({
      ok: true,
      json: async () => ({
        sessions: [{
          session: {
            id: "session-http",
            provider: "claude",
            repo_origin: "LUDIARS/Revisor",
            branch: "feat/review",
          },
          conversation: [{ payload: { text: "review request" } }],
        }],
      }),
    }),
  });
  assert.equal(context.source, "concordia-http");
  assert.equal(context.provider, "claude");
  assert.match(context.text, /review request/);
});

test("reads the persisted DB when Concordia is stopped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "revisor-concordia-"));
  const dbPath = join(directory, "concordia.db");
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      repo_origin TEXT,
      branch TEXT,
      last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE transcript_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      payload TEXT NOT NULL
    );
  `);
  database.prepare(
    "INSERT INTO sessions (id, provider, repo_origin, branch, last_seen_at) VALUES (?, ?, ?, ?, ?)",
  ).run("session-db", "codex", "LUDIARS/Revisor", "feat/review", 10);
  database.prepare(
    "INSERT INTO transcript_logs (session_id, payload) VALUES (?, ?)",
  ).run("session-db", JSON.stringify({ text: "persisted request" }));
  database.close();
  try {
    const context = await loadPersistedConcordiaContext({
      workspaceRoot: directory,
      repository: "LUDIARS/Revisor",
      headRef: "feat/review",
      dbPath,
    });
    assert.equal(context.source, "concordia-db");
    assert.equal(context.provider, "codex");
    assert.match(context.text, /persisted request/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
