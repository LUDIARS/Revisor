import test from "node:test";
import assert from "node:assert/strict";
import { handleRiskReassessment, completedRiskCycle, notifyRiskOnce } from "../src/risk-reassessment.mjs";
import { autoMergeDecision } from "../src/auto-merge.mjs";
import { LocalPrService } from "../src/local-pr-service.mjs";
import { notifyRiskSystem, riskNoticeText } from "../src/risk-notice.mjs";

const settings = { autoMergeEnabled: true, autoMergeRiskThreshold: 100 };
function fixture(score = 100) {
  let pr = { id: "p", number: 1, repository: "LUDIARS/Test", status: "open", checkStatus: "test_ok",
    jobId: "original", headSha: "a".repeat(40), reviewedHeadSha: "a".repeat(40), sessionId: "test",
    mergeRisk: { score, factors: [] }, reasons: [], humanQuestion: null };
  return { getPullRequest: () => structuredClone(pr),
    updatePullRequest: (_id, patch) => (pr = { ...pr, ...patch }),
    updatePullRequestWith: (_id, create) => (pr = { ...pr, ...create(structuredClone(pr)) }) };
}
for (const score of [59, 60, 99, 100, 101]) test("threshold boundary " + score, () => {
  assert.equal(autoMergeDecision(fixture(score).getPullRequest(), settings).merge, score < 100);
});
test("unknown score and concrete blockers are not auto-merged at threshold 100", () => {
  for (const patch of [{ mergeRisk: null }, { humanQuestion: "approve?" }, { reasons: ["test failure"] }]) {
    const store = fixture(60); store.updatePullRequest("p", patch);
    assert.equal(autoMergeDecision(store.getPullRequest(), settings).merge, false);
  }
});
test("concurrent entry and head-advancing autofix consume one durable cycle", async () => {
  const store = fixture(); let retries = 0; let notices = 0;
  const options = { store, id: "p", enabled: true, notify: async () => { notices++; return "accepted"; },
    requeue: async () => { retries++; await new Promise((resolve) => setImmediate(resolve)); store.updatePullRequest("p", { checkStatus: "queued", jobId: "retry" }); } };
  await Promise.all([handleRiskReassessment(options), handleRiskReassessment(options)]);
  assert.equal(retries, 1);
  const job = { id: "retry", request: { riskReassessment: true, headSha: "a".repeat(40) }, result: { reviewedHeadSha: "b".repeat(40) } };
  store.updatePullRequest("p", { ...completedRiskCycle(store.getPullRequest(), job), checkStatus: "test_ok", headSha: "b".repeat(40) });
  await handleRiskReassessment(options);
  await handleRiskReassessment(options);
  assert.equal(retries, 1); assert.equal(notices, 1);
  assert.equal(store.getPullRequest().riskReassessment.state, "held");
  assert.equal(autoMergeDecision(store.getPullRequest(), settings).merge, false);
});
test("successful corrected head is eligible but does not acquire another cycle", async () => {
  const store = fixture();
  await handleRiskReassessment({ store, id: "p", enabled: true, requeue: async () => {} });
  store.updatePullRequest("p", { ...completedRiskCycle(store.getPullRequest(), { id: "retry",
    request: { riskReassessment: true }, result: { reviewedHeadSha: "b".repeat(40) } }), mergeRisk: { score: 65, factors: [] } });
  assert.equal(await handleRiskReassessment({ store, id: "p", enabled: true }), false);
  assert.equal(autoMergeDecision(store.getPullRequest(), settings).merge, true);
});
test("failed admission is held and reported without automatically replaying it", async () => {
  const store = fixture(); let tries = 0;
  const options = { store, id: "p", enabled: true, requeue: async () => { tries++; throw Error("offline"); } };
  await handleRiskReassessment(options); await handleRiskReassessment(options);
  assert.equal(tries, 1); assert.equal(store.getPullRequest().riskReassessment.state, "held");
  assert.equal(store.getPullRequest().riskNotices.needs_human.status, "unavailable");
});
test("explicit human question prevents automatic repair", async () => {
  const store = fixture(); store.updatePullRequest("p", { humanQuestion: "choose scope" });
  await handleRiskReassessment({ store, id: "p", enabled: true, requeue: () => assert.fail("must not repair") });
  assert.equal(store.getPullRequest().humanQuestion, "choose scope");
});
test("worker failure and restarted reserved cycle go to human attention", async () => {
  const store = fixture();
  await handleRiskReassessment({ store, id: "p", enabled: true, requeue: async () => {} });
  const patch = completedRiskCycle(store.getPullRequest(), { id: "retry", request: { riskReassessment: true } }, true);
  store.updatePullRequest("p", { ...patch, checkStatus: "failed" });
  await handleRiskReassessment({ store, id: "p", enabled: true });
  assert.equal(store.getPullRequest().riskReassessment.state, "held");
});
test("notice result unknown is retained without duplicate mention", async () => {
  const store = fixture(65); let calls = 0;
  const notify = async () => { calls++; throw Error("timeout"); };
  await notifyRiskOnce({ store, id: "p", event: "merged", notify });
  await notifyRiskOnce({ store, id: "p", event: "merged", notify });
  assert.equal(calls, 1); assert.equal(store.getPullRequest().riskNotices.merged.status, "unknown");
});
test("system adapter requests configured admin and distinguishes old Cc acceptance", async () => {
  const pr = fixture(65).getPullRequest(); let payload;
  const transport = async (_url, options) => { payload = JSON.parse(options.body); return { ok: true, json: async () => ({ mention_admin_resolved: true }) }; };
  assert.equal(await notifyRiskSystem({ baseUrl: "http://cc", event: "merged", pullRequest: pr, transport }), "accepted");
  assert.equal(payload.channel, "system"); assert.equal(payload.mention_admin, true);
  assert.equal(payload.session_id, null); // Shared system channel, even after submitting session ends.
  assert.equal(await notifyRiskSystem({ baseUrl: "http://cc", event: "merged", pullRequest: pr,
    transport: async () => ({ ok: true, json: async () => ({}) }) }), "mention_unconfirmed");
  assert.ok(!riskNoticeText("merged", { ...pr, title: "@everyone <@123>" }).includes("@everyone"));
});
test("service completion path reports a persistently high corrected PR without merging", async () => {
  const store = fixture(); store.updatePullRequest("p", { riskReassessment: { state: "completed", attempts: 1 } });
  let notices = 0;
  const service = new LocalPrService({ store, queue: {}, loadSettings: () => settings,
    notifyRisk: async () => { notices++; return "accepted"; } });
  await service.autoMergeIfEligible("p"); await service.autoMergeIfEligible("p");
  assert.equal(notices, 1); assert.equal(store.getPullRequest().status, "open");
});

test("Genius human-only decision is not sent to autonomous repair", async () => {
  const store = fixture(); store.updatePullRequest("p", { checkStatus: "action_required", reviewer: "genius",
    reasons: ["Genius 判断カードには人間の判断が必要です"], geniusGuidance: { cards: [{ id: "card" }] } });
  await handleRiskReassessment({ store, id: "p", enabled: true, requeue: () => assert.fail("human-only hold") });
  assert.equal(store.getPullRequest().riskReassessment.state, "held");
});
