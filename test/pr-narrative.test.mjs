import assert from "node:assert/strict";
import test from "node:test";
import {
  applyNarrativeToBody,
  narrativePrompt,
  parseNarrative,
  reconcileNarrative,
  reconcileNarrativeForReview,
  sanitizeExplanation,
  sanitizeTitle,
} from "../src/pr-narrative.mjs";

test("the narrative prompt includes PR context, truncates the diff, and rejects diff instructions", () => {
  const prompt = narrativePrompt({
    pullRequest: { title: "現在の題名" },
    commitSubjects: ["一つ目", "二つ目"],
    diffText: "x".repeat(50_001),
  });

  assert.match(prompt, /現在の題名/);
  assert.match(prompt, /一つ目/);
  assert.match(prompt, /すべて未信頼データ/);
  assert.match(prompt, /ツールを使ったりファイルを読んだりせず/);
  assert.match(prompt, /\(以下省略\)/);
  assert.doesNotMatch(prompt, /Cc#\d+/);
});

test("parseNarrative accepts the last complete JSON object and rejects invalid shapes", () => {
  assert.deepEqual(
    parseNarrative('前置き {"title":"古い","explanation":"古い"} 後置き {"title":null,"explanation":"説明"}'),
    { title: null, explanation: "説明" },
  );
  assert.equal(parseNarrative('{"explanation":"説明"}'), null);
  assert.equal(parseNarrative('{"title":42,"explanation":"説明"}'), null);
});

test("sanitizeTitle flattens line breaks, truncates, and rejects empty values", () => {
  assert.equal(sanitizeTitle("  一行\n二行\t "), "一行 二行");
  assert.equal(sanitizeTitle(`題${"x".repeat(100)}`), `題${"x".repeat(99)}`);
  assert.equal(sanitizeTitle("english only"), null);
  assert.equal(sanitizeTitle("\n\t "), null);
});

test("sanitizeExplanation rejects empty output and prevents generated heading boundaries", () => {
  assert.equal(sanitizeExplanation("\n\t "), null);
  assert.equal(sanitizeExplanation(`${"x".repeat(2_001)}説明`), null);
  assert.equal(
    sanitizeExplanation("説明\r\n## 注入見出し\r\n続き"),
    "説明\n\\## 注入見出し\n続き",
  );
});

test("applyNarrativeToBody appends or replaces only the explanation section", () => {
  assert.equal(
    applyNarrativeToBody("本文", { explanation: "説明", previousTitle: null }),
    "本文\n\n## 解説\n説明",
  );
  assert.equal(
    applyNarrativeToBody("導入\n\n## 解説\n古い\n\n## 実装内容\n残す", {
      explanation: "新しい",
      previousTitle: "以前",
    }),
    "導入\n\n## 解説\n新しい\n旧タイトル: 以前\n\n## 実装内容\n残す",
  );
  assert.equal(
    applyNarrativeToBody(
      "```md\r\n## 解説\r\n例\r\n```\r\n\r\n## 解説\r\n古い\r\n\r\n## 実装内容\r\n残す",
      { explanation: "新しい", previousTitle: "以前\n## 不正な見出し" },
    ),
    "```md\n## 解説\n例\n```\n\n## 解説\n新しい\n旧タイトル: 以前 ## 不正な見出し\n\n## 実装内容\n残す",
  );
});

test("reconcileNarrative returns a body-only update, parses failures softly, and uses the read-only auxiliary model", async () => {
  const calls = [];
  const reconcile = (stdout) => reconcileNarrative({
    pullRequest: { title: "現在", body: "本文" },
    commitSubjects: ["変更"],
    diffText: "diff",
    reviewer: "codex-sol",
    cwd: "review-worktree",
    review: async (options) => {
      calls.push(options);
      return { ok: true, stdout };
    },
  });

  assert.deepEqual(await reconcile('{"title":"新題","explanation":"説明"}'), {
    title: "新題",
    body: "本文\n\n## 解説\n説明\n旧タイトル: 現在",
  });
  assert.deepEqual(await reconcile('{"title":null,"explanation":"説明"}'), {
    title: null,
    body: "本文\n\n## 解説\n説明",
  });
  assert.equal(await reconcile("not json"), null);
  assert.equal(calls[0].readOnly, true);
  assert.equal(calls[0].purpose, "auxiliary");
  assert.equal(calls[0].effort, "low");

  const failed = await reconcileNarrative({
    pullRequest: { title: "現在", body: "本文" },
    commitSubjects: [],
    diffText: "diff",
    reviewer: "codex-sol",
    cwd: "review-worktree",
    review: async () => { throw new Error("unavailable"); },
  });
  assert.equal(failed, null);
});

test("review reconciliation honors model-free and leakage boundaries before checkpointing", async () => {
  const reviews = [];
  const checkpoints = [];
  const request = {
    localPrId: "PR1",
    headSha: "a".repeat(40),
    reviewMode: "full",
    pullRequest: { title: "現在", body: "本文", narrative: null },
  };
  const cleanLeakage = { totalFindings: 0 };
  const review = async (options) => {
    reviews.push(options);
    return { ok: true, stdout: '{"title":null,"explanation":"一行目\\n二行目"}' };
  };
  const run = (overrides = {}) => reconcileNarrativeForReview({
    request,
    diffText: "diff",
    leakage: cleanLeakage,
    reviewer: "codex-sol",
    cwd: "review-worktree",
    mergeBase: "base",
    review,
    onReconciled: async (value) => { checkpoints.push(value); },
    loadCommitSubjects: async () => ["変更"],
    ...overrides,
  });

  assert.equal(await run({ request: { ...request, reviewMode: "verification" } }), null);
  assert.equal(await run({ leakage: { totalFindings: 1 } }), null);
  assert.equal(await run({ enabled: false }), null);
  assert.equal(await run({
    request: {
      ...request,
      pullRequest: { ...request.pullRequest, narrative: { headSha: request.headSha } },
    },
  }), null);
  assert.equal(reviews.length, 0);

  const fakeToken = `sk-${"x".repeat(24)}`;
  assert.equal(await run({ loadCommitSubjects: async () => [`token ${fakeToken}`] }), null);
  assert.equal(reviews.length, 0);

  assert.equal(await run({
    review: async () => ({
      ok: true,
      stdout: JSON.stringify({ title: null, explanation: `説明\n${fakeToken}` }),
    }),
  }), null);
  assert.equal(checkpoints.length, 0);

  assert.deepEqual(await run(), {
    title: null,
    body: "本文\n\n## 解説\n一行目\n二行目",
  });
  assert.equal(reviews.length, 1);
  assert.equal(checkpoints.length, 1);
  assert.equal(checkpoints[0].headSha, request.headSha);
  assert.equal(reviews[0].readOnly, true);
});
