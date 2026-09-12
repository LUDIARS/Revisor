import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { publishPushHandoff } from "../src/push-handoff.mjs";

function fixture() {
  const cwd = resolve("Product");
  const oldSha = "1".repeat(40), newSha = "2".repeat(40);
  const h = { id: "e58bfe65-fcdd-4fa4-a9c7-465308a1f79b", repository: "LUDIARS/Product", cwd,
    reason: "Replace approved history", updates: [{ ref: "refs/heads/main", oldSha, newSha }] };
  const repository = { repository: h.repository, rootPath: cwd, baseRef: "main", workflow: "revisor" };
  const rows = new Map();
  const calls = [];
  let remoteSha = oldSha;
  let clock = 0;
  const deps = {
    sessionId: "session-one", env: {}, now: () => clock,
    store: { findRepositoryByPath: () => repository },
    ledger: {
      find: (id) => rows.get(id),
      create(doc, sessionId, digest, updated_at) {
        if (rows.has(doc.id)) return false;
        rows.set(doc.id, { id: doc.id, document: doc, sessionId, digest, updated_at, status: "awaiting_approval", detail: {} });
        return true;
      },
      transition(id, from, status, detail, updated_at) {
        const row = rows.get(id); assert.equal(row.status, from);
        Object.assign(row, { status, detail, updated_at });
      },
    },
    coordinator: { run: async (fn) => { calls.push("lock"); return fn(); } },
    endpointFor: () => "http://127.0.0.1:11111/v1/sessions/session-one",
    realPath: async (p) => p,
    runGit: async (_cwd, args) => {
      if (args[0] === "rev-parse") return ".git";
      if (args[0] === "remote") return "https://github.com/LUDIARS/Product.git";
      if (args[0] === "check-ref-format") return "";
      if (args[0] === "cat-file") return "commit";
      if (args[0] === "branch") return "main";
      throw new Error(`Unexpected git ${args}`);
    },
    requestApproval: async () => { calls.push("approval"); return { reason: "approved" }; },
    verifySession: async () => { calls.push("binding"); },
    resolveAccess: async () => ({ reachable: true, token: "test-token" }),
    remoteGit: async ({ args, authorizedPublication }) => {
      assert.equal(authorizedPublication, true);
      calls.push(args[0]);
      if (args[0] === "ls-remote") return `${remoteSha}\trefs/heads/main`;
      assert.equal(args[0], "push");
      assert.equal(rows.get(h.id).status, "attempting");
      assert.ok(args.includes(`--force-with-lease=refs/heads/main:${oldSha}`));
      remoteSha = newSha;
      return "";
    },
  };
  return { h, deps, rows, calls, setRemote: (sha) => { remoteSha = sha; }, advance: (ms) => { clock += ms; } };
}

test("one approved handoff publishes once and duplicate delivery is read-only", async () => {
  const f = fixture();
  assert.equal((await publishPushHandoff(f.h, f.deps)).status, "published");
  const calls = [...f.calls];
  assert.equal((await publishPushHandoff(f.h, f.deps)).status, "published");
  assert.deepEqual(f.calls, calls);
  assert.ok(f.calls.indexOf("approval") < f.calls.indexOf("push"));
  await assert.rejects(publishPushHandoff({ ...f.h, reason: "changed" }, f.deps), /different content/);
});

test("denial, changed remote and expired approval never call push", async () => {
  for (const failure of ["denied", "moved", "expired"]) {
    const f = fixture();
    if (failure === "denied") f.deps.requestApproval = async () => { throw new Error("denied"); };
    if (failure === "moved") f.setRemote("3".repeat(40));
    if (failure === "expired") f.deps.coordinator.run = async (fn) => { f.advance(120001); return fn(); };
    await assert.rejects(publishPushHandoff(f.h, f.deps));
    assert.equal(f.rows.get(f.h.id).status, "rejected");
    assert.ok(!f.calls.includes("push"));
  }
});

test("lost push response is unknown, reconciliation observes desired refs without sending again", async () => {
  const f = fixture();
  const remote = f.deps.remoteGit;
  f.deps.remoteGit = async (request) => {
    const result = await remote(request);
    if (request.args[0] === "push") throw new Error("lost connection");
    return result;
  };
  await assert.rejects(publishPushHandoff(f.h, f.deps), /lost connection/);
  assert.equal(f.rows.get(f.h.id).status, "unknown");
  assert.equal((await publishPushHandoff(f.h, { ...f.deps, reconcile: true })).status, "published");
  assert.equal(f.calls.filter((c) => c === "push").length, 1);
  assert.equal(f.calls.filter((c) => c === "approval").length, 1);
});

test("a rebound Cc session cannot publish", async () => {
  const f = fixture(); let checks = 0;
  f.deps.verifySession = async () => { if (++checks === 2) throw new Error("rebound"); };
  await assert.rejects(publishPushHandoff(f.h, f.deps), /rebound/);
  assert.ok(!f.calls.includes("push"));
});
