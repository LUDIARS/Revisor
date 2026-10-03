import assert from "node:assert/strict";
import test from "node:test";
import {
  notifyReviewRestart,
  REVIEW_RESTART_REASONS,
  reviewRestartMessage,
} from "../src/review-restart-notice.mjs";

const PULL_REQUEST = Object.freeze({
  repository: "LUDIARS/Revisor",
  number: 42,
  sessionId: "lictor-1",
  reviewLane: "standard",
});

test("the restart message names the PR and why it went back to review", () => {
  const text = reviewRestartMessage(PULL_REQUEST, REVIEW_RESTART_REASONS.STALE_CONTENT);
  assert.match(text, /^🔁 Revisor 再審査開始: LUDIARS\/Revisor#42$/m);
  assert.match(text, /理由: 審査後に差分の内容が変わった/);
  assert.match(text, /審査完了時にあらためて通知します/);

  for (const reason of Object.values(REVIEW_RESTART_REASONS)) {
    assert.doesNotMatch(reviewRestartMessage(PULL_REQUEST, reason), /理由: (manual|interrupted|stale_content|risk_reassessment)$/m);
  }
  assert.match(
    reviewRestartMessage({ ...PULL_REQUEST, reviewLane: "fast" }, REVIEW_RESTART_REASONS.MANUAL),
    /#42 \(ファストレーン\)/,
  );
});

test("the restart notice goes to the submitting session only", async () => {
  const sent = [];
  const notify = async (message) => {
    sent.push(message);
    return true;
  };
  assert.equal(await notifyReviewRestart({
    pullRequest: PULL_REQUEST,
    reason: REVIEW_RESTART_REASONS.INTERRUPTED,
    baseUrl: "http://127.0.0.1:11111",
    notify,
  }), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].sessionId, "lictor-1");
  assert.match(sent[0].text, /中断された審査/);

  assert.equal(await notifyReviewRestart({
    pullRequest: { ...PULL_REQUEST, sessionId: null },
    reason: REVIEW_RESTART_REASONS.MANUAL,
    baseUrl: "http://127.0.0.1:11111",
    notify,
  }), false);
  assert.equal(await notifyReviewRestart({
    pullRequest: PULL_REQUEST,
    reason: REVIEW_RESTART_REASONS.MANUAL,
    baseUrl: null,
    notify,
  }), false);
  assert.equal(sent.length, 1);
});
