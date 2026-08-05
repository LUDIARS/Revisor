import assert from "node:assert/strict";
import test from "node:test";
import { autoMergeDecision } from "../src/auto-merge.mjs";
import { GENIUS_HUMAN_DECISION_REASON } from "../src/human-decision.mjs";
import { decidePullRequest, decidePullRequests } from "../src/pr-disposition.mjs";

function pullRequest(overrides = {}) {
  return {
    id: "pr-1",
    number: 1,
    repository: "LUDIARS/Revisor",
    status: "open",
    checkStatus: "test_ok",
    draft: false,
    reasons: [],
    advisories: [],
    humanQuestion: null,
    mergeRisk: { score: 8, band: "low", bandLabel: "低", factors: [] },
    runtimeVerification: { required: false, score: 0, factors: [], evidence: [] },
    updatedAt: "2026-07-30T00:00:00.000Z",
    ...overrides,
  };
}

const SETTINGS = {
  autoMergeEnabled: true,
  autoMergeRiskThreshold: 15,
  autoMergeRequiresRuntimeVerificationClear: true,
};

test("a clean low-risk PR is auto-merge eligible", () => {
  const decided = decidePullRequest(pullRequest(), SETTINGS);
  assert.equal(decided.decision.state, "auto_ok");
  assert.deepEqual(decided.decision.blockers, []);
  assert.equal(decided.decision.autoMergeEligible, true);
  assert.equal(autoMergeDecision(pullRequest(), SETTINGS).merge, true);
});

test("risk above the human's threshold hands the PR back to the human", () => {
  const decided = decidePullRequest(
    pullRequest({ mergeRisk: { score: 40, band: "moderate", bandLabel: "中", factors: [] } }),
    SETTINGS,
  );
  assert.equal(decided.decision.state, "needs_human");
  assert.match(decided.decision.blockers.join(" "), /マージリスク 40 が閾値 15/);
  assert.equal(decided.decision.autoMergeEligible, false);
});

test("raising the threshold releases the same PR without a re-review", () => {
  const risky = pullRequest({
    mergeRisk: { score: 40, band: "moderate", bandLabel: "中", factors: [] },
  });
  assert.equal(
    decidePullRequest(risky, { ...SETTINGS, autoMergeRiskThreshold: 50 }).decision.state,
    "auto_ok",
  );
});

test("a required human run blocks auto-merge while the operator asks for it", () => {
  const needsRun = pullRequest({
    runtimeVerification: { required: true, score: 60, factors: [], evidence: [] },
  });
  assert.equal(decidePullRequest(needsRun, SETTINGS).decision.state, "needs_human");
  assert.equal(
    decidePullRequest(needsRun, {
      ...SETTINGS,
      autoMergeRequiresRuntimeVerificationClear: false,
    }).decision.state,
    "auto_ok",
  );
});

test("draft, blocking reasons and open questions each need a human", () => {
  for (const overrides of [
    { draft: true },
    { reasons: ["target domain is still missing"] },
    { humanQuestion: "どのドメインに属しますか?" },
    { checkStatus: "action_required" },
    { checkStatus: "failed" },
  ]) {
    const decided = decidePullRequest(pullRequest(overrides), SETTINGS);
    assert.notEqual(decided.decision.state, "auto_ok", JSON.stringify(overrides));
    assert.equal(decided.decision.autoMergeEligible, false);
  }
});

test("only a sole Genius card hold is offered as a human-decision merge", () => {
  const hold = {
    checkStatus: "action_required",
    reviewer: "genius",
    reasons: [GENIUS_HUMAN_DECISION_REASON],
    geniusGuidance: { cards: [{ id: "public-card" }] },
  };
  const offered = decidePullRequest(pullRequest(hold), SETTINGS);
  assert.equal(offered.decision.humanDecisionMergeable, true);
  // 保留を解けるのは人間の明示操作だけで、オートマージ対象にはならない。
  assert.equal(offered.decision.state, "needs_human");
  assert.equal(offered.decision.autoMergeEligible, false);

  for (const overrides of [
    { reasons: [GENIUS_HUMAN_DECISION_REASON, "registered test case(s) failed"] },
    { reasons: [] },
    { geniusGuidance: { cards: [] } },
    { geniusGuidance: null },
    { reviewer: "codex" },
    { draft: true },
    { checkStatus: "test_ok" },
    { status: "closed" },
  ]) {
    assert.equal(
      decidePullRequest(pullRequest({ ...hold, ...overrides }), SETTINGS)
        .decision.humanDecisionMergeable,
      false,
      JSON.stringify(overrides),
    );
  }
});

test("a settled review always says why it is waiting", () => {
  const blocked = decidePullRequest(
    pullRequest({ checkStatus: "action_required", reasons: ["target domain is still missing"] }),
    SETTINGS,
  );
  assert.equal(blocked.decision.state, "needs_human");
  assert.ok(blocked.decision.blockers.includes("target domain is still missing"));

  const failed = decidePullRequest(
    pullRequest({
      checkStatus: "failed",
      error: "The local review worker failed.",
      mergeRisk: null,
      runtimeVerification: null,
    }),
    SETTINGS,
  );
  assert.equal(failed.decision.state, "failed");
  assert.ok(failed.decision.blockers.includes("The local review worker failed."));

  // A review still in flight has nothing to explain yet.
  assert.deepEqual(
    decidePullRequest(pullRequest({ checkStatus: "running", draft: true }), SETTINGS)
      .decision.blockers,
    [],
  );
});

test("a running review is neither a decision nor a failure", () => {
  for (const checkStatus of ["queued", "running"]) {
    assert.equal(
      decidePullRequest(pullRequest({ checkStatus }), SETTINGS).decision.state,
      "in_review",
    );
  }
});

test("the list puts human decisions first, then the riskiest", () => {
  const ordered = decidePullRequests([
    pullRequest({ id: "clean", checkStatus: "test_ok" }),
    pullRequest({ id: "running", checkStatus: "running" }),
    pullRequest({
      id: "risky",
      mergeRisk: { score: 60, band: "high", bandLabel: "高", factors: [] },
    }),
    pullRequest({
      id: "riskiest",
      mergeRisk: { score: 90, band: "critical", bandLabel: "重大", factors: [] },
    }),
    pullRequest({ id: "failed", checkStatus: "failed" }),
  ], SETTINGS);
  assert.deepEqual(
    ordered.map((entry) => entry.id),
    ["riskiest", "risky", "failed", "running", "clean"],
  );
});

test("auto-merge stays off until the operator enables it", () => {
  const decided = decidePullRequest(pullRequest(), { ...SETTINGS, autoMergeEnabled: false });
  assert.equal(decided.decision.state, "auto_ok");
  assert.equal(decided.decision.autoMergeEligible, false);
  const decision = autoMergeDecision(pullRequest(), { ...SETTINGS, autoMergeEnabled: false });
  assert.equal(decision.merge, false);
  assert.match(decision.reason, /オートマージは無効/);
});

test("a merged PR is neither a decision nor auto-mergeable again", () => {
  const decided = decidePullRequest(pullRequest({ status: "merged" }), SETTINGS);
  assert.equal(decided.decision.state, "merged");
  assert.equal(decided.decision.autoMergeEligible, false);
  assert.equal(autoMergeDecision(pullRequest({ status: "merged" }), SETTINGS).merge, false);
});

test("a closed PR is neither a decision nor auto-mergeable again", () => {
  const decided = decidePullRequest(pullRequest({ status: "closed" }), SETTINGS);
  assert.equal(decided.decision.state, "closed");
  assert.equal(decided.decision.label, "取り下げ");
  assert.equal(decided.decision.autoMergeEligible, false);
  // 取り下げた PR に判断を求め続けない (board は blockers の有無で人間を呼ぶ)。
  assert.deepEqual(decided.decision.blockers, []);
  assert.equal(autoMergeDecision(pullRequest({ status: "closed" }), SETTINGS).merge, false);
});

test("a closed PR that failed review still reports no blockers", () => {
  const decided = decidePullRequest(
    pullRequest({ status: "closed", checkStatus: "action_required", reasons: ["target domain is still missing"] }),
    SETTINGS,
  );
  assert.equal(decided.decision.state, "closed");
  assert.deepEqual(decided.decision.blockers, []);
});
