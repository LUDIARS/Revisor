import assert from "node:assert/strict";
import test from "node:test";
import {
  ANTIPATTERN_FETCH_FAILED,
  antipatternFindings,
  antipatternInstruction,
  antipatternReportBlock,
} from "../src/antipattern-review.mjs";
import { finalReviewReportEntry, reviewReportEntry } from "../src/review-report.mjs";
import { buildReviewerPrompt } from "../src/reviewer-prompt.mjs";

const ITEMS = [
  { id: "AP01", title: "応答が 1 秒を超える", detect: ["同期の外部呼び出し"], fix: "キャッシュする" },
  { id: "AP03", title: "毎回全件取り直す", detect: ["一覧 API で外部全件取得"], fix: "差分取得にする" },
];
const FETCHED = { status: "fetched", items: ITEMS, skipped: 0, fetchedAt: "2026-10-17T00:00:00.000Z", reason: null };
const UNAVAILABLE = { status: "unavailable", items: [], skipped: 0, fetchedAt: null, reason: "request failed" };

test("instruction lists id/title/detect/fix and asks for AP-ID findings without a new gate", () => {
  const text = antipatternInstruction(FETCHED);
  for (const item of ITEMS) {
    assert.ok(text.includes(item.id));
    assert.ok(text.includes(item.title));
    assert.ok(text.includes(item.detect[0]));
    assert.ok(text.includes(item.fix));
  }
  assert.match(text, /\[AP01\]/);
  assert.match(text, /not a new merge-blocking condition/);
  assert.match(text, /must not cause PR_GATE_NEEDS_HUMAN/);
});

test("instruction says perspectives are unavailable instead of listing nothing", () => {
  assert.match(antipatternInstruction(UNAVAILABLE), /unavailable/);
});

test("reviewer prompt carries the perspective only when one is passed", () => {
  const base = {
    request: { repository: "LUDIARS/Revisor", number: 1, baseRef: "main" },
    analysis: { domain: { hasTargetDomain: true, targetDomains: [] } },
    authorContext: null,
    unifiedDiff: "",
    leakage: { totalFindings: 0 },
  };
  assert.equal(buildReviewerPrompt(base).includes("Elegantia"), false);
  assert.ok(buildReviewerPrompt({ ...base, antipatterns: FETCHED }).includes("Elegantia anti-pattern catalog"));
  assert.ok(buildReviewerPrompt({ ...base, antipatterns: UNAVAILABLE }).includes("perspectives are unavailable"));
});

test("findings keep only lines that cite a catalog AP id", () => {
  const output = [
    "[AP01] src/server.mjs:40 — Excubitor をリクエスト中に同期照会している",
    "[AP99] 存在しない ID",
    "No other issue.",
  ].join("\n");
  assert.deepEqual(antipatternFindings(output, FETCHED), [
    { id: "AP01", text: "[AP01] src/server.mjs:40 — Excubitor をリクエスト中に同期照会している" },
  ]);
  assert.deepEqual(antipatternFindings(output, UNAVAILABLE), []);
});

test("report block states a fetch failure explicitly", () => {
  const failed = antipatternReportBlock(UNAVAILABLE, "[AP01] x");
  assert.ok(failed.summary.startsWith(ANTIPATTERN_FETCH_FAILED));
  assert.equal(failed.reason, "request failed");
  assert.deepEqual(failed.findings, []);
  const stale = antipatternReportBlock({ ...FETCHED, status: "stale", reason: "HTTP 503" }, null);
  assert.ok(stale.summary.startsWith(ANTIPATTERN_FETCH_FAILED));
  assert.match(stale.summary, /前回取得分 2 件/);
  const ok = antipatternReportBlock(FETCHED, "[AP03] src/list.mjs:3 — 全件取得");
  assert.equal(ok.summary, "アンチパターン観点: 2 件");
  assert.equal(ok.reason, null);
  assert.deepEqual(ok.ids, ["AP01", "AP03"]);
  assert.equal(ok.findings[0].id, "AP03");
});

test("review report entries carry the anti-pattern block", () => {
  const block = antipatternReportBlock(UNAVAILABLE);
  assert.deepEqual(reviewReportEntry("review", { antipatterns: block }).content.antipatterns, block);
  assert.deepEqual(finalReviewReportEntry({ conclusion: "success", antipatterns: block }).content.antipatterns, block);
  assert.equal(finalReviewReportEntry({ conclusion: "success" }).content.antipatterns, null);
});
