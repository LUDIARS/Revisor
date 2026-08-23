import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateExternalVerification } from "../src/local-contracts.mjs";
import { effectiveMergeRisk } from "../src/merge-risk.mjs";
import { decidePullRequest } from "../src/pr-disposition.mjs";
import { LocalPrService } from "../src/local-pr-service.mjs";
import { LocalPrStore } from "../src/state-store.mjs";
import { createUiRequestHandler } from "../src/ui-server.mjs";

const HEAD = "a".repeat(40);
const verification = (overrides = {}) => ({
  source: "augur",
  headSha: HEAD,
  runId: "run-1",
  decision: "accept",
  by: "neco",
  at: "2026-08-23T00:00:00.000Z",
  summary: { total: 1, passed: 1, failed: 0, skipped: 0, error: 0 },
  bundle: { kind: "pr", testIds: ["test-1"] },
  reportUrl: null,
  note: null,
  ...overrides,
});

function pullRequest(overrides = {}) {
  return {
    id: "pr-1",
    status: "open",
    checkStatus: "test_ok",
    headSha: HEAD,
    mergeRisk: {
      score: 20,
      band: "low",
      bandLabel: "低",
      factors: [{
        code: "runtime_verification",
        points: 20,
        detail: "人間による動作確認が必要な変更です",
      }],
    },
    runtimeVerification: { required: true, score: 30, factors: [], evidence: [] },
    ...overrides,
  };
}

test("validates only accepted Augur verification for a full SHA", () => {
  assert.equal(validateExternalVerification(verification()).headSha, HEAD);
  assert.throws(() => validateExternalVerification(verification({ decision: "reject" })), /accept/);
  assert.throws(() => validateExternalVerification(verification({ headSha: "bad" })), /40-character/);
  assert.throws(() => validateExternalVerification(verification({ headSha: ` ${HEAD}` })), /40-character/);
  assert.throws(() => validateExternalVerification(verification({
    bundle: { kind: "pr" },
  })), /testIds/);
  assert.throws(() => validateExternalVerification(verification({
    note: "n".repeat(2_001),
  })), /note/);
  assert.equal(validateExternalVerification(verification({ note: "" })).note, "");
});

test("current external verification clears the runtime hold and expires with a moved head", () => {
  const settings = {
    autoMergeEnabled: true,
    autoMergeRiskThreshold: 15,
    autoMergeRequiresRuntimeVerificationClear: true,
  };
  const current = decidePullRequest(pullRequest({ externalVerification: verification() }), settings);
  assert.equal(current.decision.state, "auto_ok");
  assert.equal(current.decision.autoMergeEligible, true);
  assert.equal(current.decision.externalVerification.current, true);
  assert.equal(current.decision.riskScore, 0);
  assert.equal(current.decision.blockers.includes("人間による動作確認が必要です"), false);
  const stale = decidePullRequest(
    pullRequest({ headSha: "b".repeat(40), externalVerification: verification() }),
    settings,
  );
  assert.equal(stale.decision.externalVerification.current, false);
  assert.equal(stale.decision.riskScore, 20);
  assert.ok(stale.decision.blockers.includes("人間による動作確認が必要です"));
});

test("merge-risk records the external verification clearing factor", () => {
  const risk = effectiveMergeRisk(pullRequest({ externalVerification: verification() }));
  assert.equal(risk.factors.find((factor) => factor.code === "external_verification_cleared")?.points, 0);
  assert.equal(risk.factors.some((factor) => factor.code === "runtime_verification"), false);
  assert.equal(risk.score, 0);
  // A record for a different head leaves the stored assessment untouched.
  const stale = pullRequest({
    headSha: "b".repeat(40),
    externalVerification: verification(),
  });
  assert.deepEqual(effectiveMergeRisk(stale), stale.mergeRisk);
});

test("clearing runtime risk preserves a saturated non-runtime blocker", () => {
  const decided = decidePullRequest(pullRequest({
    reasons: ["blocking reason"],
    mergeRisk: {
      score: 100,
      band: "critical",
      bandLabel: "重大",
      factors: [
        { code: "blocking_reasons", points: 100, detail: "マージブロック理由 1 件" },
        { code: "runtime_verification", points: 20, detail: "動作確認が必要" },
      ],
    },
    externalVerification: verification(),
  }), {
    autoMergeEnabled: true,
    autoMergeRiskThreshold: 15,
    autoMergeRequiresRuntimeVerificationClear: true,
  });
  assert.equal(decided.decision.riskScore, 100);
  assert.ok(decided.decision.blockers.includes("blocking reason"));
});

test("recording rejects unknown, closed, and stale-head pull requests", () => {
  // Mirror the real store: the patch is built inside the write transaction, so
  // the status and head guards run against the record the write will see.
  const store = {
    getPullRequest: (id) => id === "pr-1" ? pullRequest() : null,
    updatePullRequestWith(id, createPatch) {
      const current = this.getPullRequest(id);
      return { ...current, ...createPatch(current) };
    },
  };
  const service = new LocalPrService({ store, queue: {}, loadSettings: () => ({}) });
  assert.throws(() => service.recordExternalVerification("missing", verification()), (error) =>
    error.status === 404
    && error.body?.error?.code === "not_found"
    && error.body?.error?.message === "Local PR was not found.");
  store.getPullRequest = () => pullRequest({ status: "closed" });
  assert.throws(() => service.recordExternalVerification("pr-1", verification()), (error) => error.status === 409 && error.body.status === "closed");
  store.getPullRequest = () => pullRequest();
  assert.throws(() => service.recordExternalVerification("pr-1", verification({ headSha: "b".repeat(40) })),
    (error) => error.status === 409 && error.body.headSha === HEAD);
});

function request(body = "", { method = "POST", url = "/api/local-prs/pr-1/verification" } = {}) {
  return {
    method,
    url,
    headers: { host: "127.0.0.1:4240", "x-revisor-session": "session" },
    async *[Symbol.asyncIterator]() { yield Buffer.from(body, "utf8"); },
  };
}

function response() {
  return {
    status: 0,
    headers: {},
    body: "",
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    },
  };
}

test("verification endpoint returns service conflicts and full PR records", async () => {
  const service = {
    listPullRequests: () => [pullRequest({ externalVerification: verification() })],
    recordExternalVerification() {
      return pullRequest({ externalVerification: verification() });
    },
  };
  const handle = createUiRequestHandler({
    env: {}, sessionToken: "session", queue: { state: () => ({}) }, localPrService: service,
  });
  const accepted = response();
  await handle(request(JSON.stringify(verification())), accepted);
  assert.equal(accepted.status, 200);
  assert.deepEqual(JSON.parse(accepted.body).pullRequest.externalVerification, verification());
  const invalid = response();
  await handle(request(JSON.stringify(verification({ decision: "reject" }))), invalid);
  assert.equal(invalid.status, 400);
  const badHead = response();
  await handle(request(JSON.stringify(verification({ headSha: "bad" }))), badHead);
  assert.equal(badHead.status, 400);
  service.recordExternalVerification = () => {
    const error = new Error("head mismatch");
    error.status = 409;
    error.body = { error: error.message, headSha: HEAD };
    throw error;
  };
  const conflict = response();
  await handle(request(JSON.stringify(verification())), conflict);
  assert.equal(conflict.status, 409);
  assert.equal(JSON.parse(conflict.body).headSha, HEAD);
  service.recordExternalVerification = () => {
    const error = new Error("closed");
    error.status = 409;
    error.body = { error: error.message, status: "closed" };
    throw error;
  };
  const terminal = response();
  await handle(request(JSON.stringify(verification())), terminal);
  assert.equal(terminal.status, 409);
  assert.equal(JSON.parse(terminal.body).status, "closed");
  service.recordExternalVerification = () => {
    const error = new Error("Local PR was not found.");
    error.status = 404;
    error.body = { error: { code: "not_found", message: error.message } };
    throw error;
  };
  const missing = response();
  await handle(request(JSON.stringify(verification()), {
    url: "/api/local-prs/missing/verification",
  }), missing);
  assert.equal(missing.status, 404);
  assert.match(missing.headers["Content-Type"], /^application\/json/);
  assert.deepEqual(JSON.parse(missing.body), {
    error: { code: "not_found", message: "Local PR was not found." },
  });
  const full = response();
  await handle(request("", { method: "GET", url: "/api/local-prs" }), full);
  assert.equal(full.status, 200);
  assert.deepEqual(JSON.parse(full.body).pullRequests[0].externalVerification, verification());
});

test("persists the latest verification with recordedAt and returns it in the full list", async () => {
  const directory = mkdtempSync(join(tmpdir(), "revisor-external-verification-"));
  const store = new LocalPrStore({
    path: join(directory, "state.db"),
    createId: () => "pr-persisted",
    now: () => "2026-08-23T01:00:00.000Z",
  });
  try {
    const created = store.createPullRequest({
      repository: "LUDIARS/Revisor",
      title: "Augur の保証を保存する",
      body: "",
      author: "neco",
      headRef: "feat/external-verification",
      baseRef: "main",
      headSha: HEAD,
      baseSha: "b".repeat(40),
    });
    store.updatePullRequest(created.id, {
      checkStatus: "test_ok",
      mergeRisk: pullRequest().mergeRisk,
      runtimeVerification: pullRequest().runtimeVerification,
    });
    const service = new LocalPrService({
      store,
      queue: {},
      loadSettings: () => ({
        autoMergeEnabled: true,
        autoMergeRiskThreshold: 15,
        autoMergeRequiresRuntimeVerificationClear: true,
      }),
    });
    const first = service.recordExternalVerification(created.id, verification());
    assert.equal(first.decision.state, "auto_ok");
    assert.equal(Number.isNaN(Date.parse(first.externalVerification.recordedAt)), false);
    const latestBody = verification({ runId: "run-2", note: "latest" });
    service.recordExternalVerification(created.id, latestBody);
    assert.equal(store.getPullRequest(created.id).externalVerification.runId, "run-2");

    const handle = createUiRequestHandler({
      env: {},
      sessionToken: "session",
      queue: { state: () => ({}) },
      localPrService: service,
    });
    const full = response();
    await handle(request("", { method: "GET", url: "/api/local-prs" }), full);
    const stored = JSON.parse(full.body).pullRequests[0].externalVerification;
    assert.equal(stored.runId, "run-2");
    assert.equal(stored.note, "latest");
    assert.equal(Number.isNaN(Date.parse(stored.recordedAt)), false);

    store.updatePullRequest(created.id, { headSha: "c".repeat(40) });
    const moved = service.getPullRequest(created.id);
    assert.equal(moved.externalVerification.runId, "run-2");
    assert.equal(moved.decision.externalVerification.current, false);
    assert.ok(moved.decision.blockers.includes("人間による動作確認が必要です"));
  } finally {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      // Windows keeps the SQLite file handle open until the store is garbage
      // collected; the temp directory is then removed by the OS. The assertions
      // above are the test, not the cleanup.
      if (error?.code !== "EPERM" && error?.code !== "EBUSY") throw error;
    }
  }
});
