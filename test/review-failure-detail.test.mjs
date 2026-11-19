import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_DETAILED_CHECKS,
  MAX_ERROR_CHARS,
  MAX_OUTPUT_LINES,
  failedCheckLines,
  failureNextStepLines,
  outputTail,
  reviewErrorLines,
} from "../src/review-failure-detail.mjs";
import { reviewCompletionMessage } from "../src/review-completion-notice.mjs";
// Concordia (src/shared/revisor-terminal-notice.ts) が先頭行だけで終局種別を読む。
// 詳細を足しても先頭行の契約は崩さない。
function revisorTerminalKindForTest(text) {
  const firstLine = text.trim().split(/\r?\n/, 1)[0] ?? "";
  if (/^⚠️ Revisor レビュー失敗: \S+#\d+ は審査を完了できませんでした。$/.test(firstLine)) return "failed";
  if (/^🔴 Revisor レビュー完了: \S+#\d+ はマージできません。$/.test(firstLine)) return "action_required";
  return null;
}

function pr(overrides = {}) {
  return {
    repository: "LUDIARS/Concordia",
    number: 7,
    status: "open",
    checkStatus: "action_required",
    reasons: [],
    advisories: [],
    humanQuestion: null,
    error: null,
    ci: [],
    ...overrides,
  };
}

test("lists each failing check with name, exit code, reason and the output tail", () => {
  const lines = failedCheckLines([
    { name: "unit", status: "passed", exitCode: 0 },
    {
      name: "unit-api",
      status: "failed",
      exitCode: 1,
      output: { text: "--- stdout ---\nnot ok 3 - rejects empty body\n  expected 400, got 500", truncated: false },
    },
    { name: "lint", status: "error", reason: "npm が見つからない", exitCode: null },
  ]).join("\n");
  assert.match(lines, /失敗した登録チェック \(2 件\)/);
  assert.match(lines, /- unit-api: 失敗 \/ exit 1/);
  assert.match(lines, /not ok 3 - rejects empty body/);
  assert.match(lines, /expected 400, got 500/);
  assert.match(lines, /- lint: 未実行 \(実行エラー\)/);
  assert.match(lines, /理由: npm が見つからない/);
  assert.doesNotMatch(lines, /- unit:/, "passing checks are not listed");
});

test("returns nothing when no check failed", () => {
  assert.deepEqual(failedCheckLines([{ name: "unit", status: "passed" }]), []);
  assert.deepEqual(failedCheckLines(undefined), []);
});

test("reports a behavior block with its domain, counts and runId", () => {
  const lines = failedCheckLines([{
    name: "動作ブロック (auth)", domain: "auth", status: "failed",
    total: 10, failed: 2, exitCode: 1, runId: "run-9",
  }]).join("\n");
  assert.match(lines, /ドメイン auth \/ 2\/10 件失敗 \/ exit 1 \/ runId run-9/);
  assert.match(lines, /出力: 記録なし/);
});

test("keeps only the output tail and says it was cut", () => {
  const text = Array.from({ length: MAX_OUTPUT_LINES + 10 }, (_, i) => `line ${i}`).join("\n");
  const tail = outputTail({ text, truncated: false });
  assert.equal(tail.cut, true);
  assert.equal(tail.text.split("\n").length, MAX_OUTPUT_LINES);
  assert.match(tail.text, new RegExp(`line ${MAX_OUTPUT_LINES + 9}$`));
  const lines = failedCheckLines([{ name: "t", status: "failed", output: { text } }]).join("\n");
  assert.match(lines, /末尾のみ。全文は PR 詳細の審査レポート/);
  assert.doesNotMatch(lines, /line 0\n/);
});

test("an upstream truncated output is also marked as cut", () => {
  assert.equal(outputTail({ text: "short", truncated: true }).cut, true);
  assert.equal(outputTail({ text: "  " }), null);
  assert.equal(outputTail(null), null);
});

test("caps the number of detailed checks", () => {
  const ci = Array.from({ length: MAX_DETAILED_CHECKS + 2 }, (_, i) => ({ name: `t${i}`, status: "failed" }));
  const lines = failedCheckLines(ci).join("\n");
  assert.match(lines, /ほか 2 件/);
  assert.doesNotMatch(lines, new RegExp(`- t${MAX_DETAILED_CHECKS}:`));
});

test("review error keeps multiple lines and states truncation", () => {
  assert.deepEqual(reviewErrorLines("worker died"), ["理由: worker died"]);
  const multi = reviewErrorLines("git fetch failed\nfatal: couldn't find remote ref").join("\n");
  assert.match(multi, /^理由:\n  git fetch failed\n  fatal: couldn't find remote ref$/);
  const long = reviewErrorLines("x".repeat(MAX_ERROR_CHARS + 50)).join("\n");
  assert.match(long, /文字で切りました/);
  assert.match(reviewErrorLines(null).join("\n"), /記録されていません/);
});

test("next step depends on whether a check failed", () => {
  assert.match(failureNextStepLines({ hasFailedChecks: true }).join(""), /再提出/);
  assert.match(failureNextStepLines({ hasFailedChecks: false }).join(""), /同じ head のまま再審査/);
});

test("failed notice carries the check detail and keeps the producer first line", () => {
  const message = reviewCompletionMessage(pr({
    checkStatus: "failed",
    error: "registered tests timed out",
    ci: [{ name: "unit", status: "failed", exitCode: 124, output: { text: "timeout after 600s" } }],
  }));
  assert.equal(message.split("\n")[0], "⚠️ Revisor レビュー失敗: LUDIARS/Concordia#7 は審査を完了できませんでした。");
  assert.equal(revisorTerminalKindForTest(message), "failed");
  assert.match(message, /理由: registered tests timed out/);
  assert.match(message, /- unit: 失敗 \/ exit 124/);
  assert.match(message, /timeout after 600s/);
  assert.doesNotMatch(message, /再実行するか、原因を確認してください/);
});

test("action_required notice adds failing check output under the block reasons", () => {
  const message = reviewCompletionMessage(pr({
    reasons: ["1 件の登録テストが失敗しました"],
    ci: [{ name: "unit", status: "failed", exitCode: 1, output: { text: "AssertionError: 1 !== 2" } }],
  }));
  assert.equal(revisorTerminalKindForTest(message), "action_required");
  assert.match(message, /ブロック理由:\n- 1 件の登録テストが失敗しました\n失敗した登録チェック/);
  assert.match(message, /AssertionError: 1 !== 2/);
});

test("action_required without failing checks is unchanged", () => {
  const message = reviewCompletionMessage(pr({ reasons: ["対象ドメインが未設定です"] }));
  assert.doesNotMatch(message, /失敗した登録チェック|次の手/);
});
