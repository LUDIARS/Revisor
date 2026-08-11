import assert from "node:assert/strict";
import test from "node:test";
import {
  notifyPullRequestLifecycle,
  pullRequestLifecycleMessage,
  pullRequestLifecycleTone,
} from "../src/pr-lifecycle-notice.mjs";

function pr(overrides = {}) {
  return {
    repository: "LUDIARS/Revisor",
    number: 12,
    sessionId: "lictor-review",
    title: "Notify Discord",
    headRef: "feat/discord-pr-notifications",
    baseRef: "main",
    status: "open",
    checkStatus: "queued",
    reasons: [],
    error: null,
    mergeCommitSha: null,
    ...overrides,
  };
}

test("formats every Discord lifecycle transition", () => {
  assert.match(pullRequestLifecycleMessage("created", pr()), /PR 発行[\s\S]*feat\/discord-pr-notifications → main/);
  const passed = pullRequestLifecycleMessage("review_passed", pr());
  assert.match(passed, /審査通過[\s\S]*Test OK/);
  assert.match(passed, /テスト開始OK/);
  assert.match(passed, /マージOK/);
  const draft = pullRequestLifecycleMessage("review_passed", pr({ draft: true }));
  assert.match(draft, /テスト開始OK/);
  assert.match(draft, /マージOK/);
  assert.match(
    pullRequestLifecycleMessage("review_failed", pr({ reasons: ["unit failed"] })),
    /審査失敗[\s\S]*unit failed/,
  );
  assert.match(
    pullRequestLifecycleMessage("merged", pr({ mergeCommitSha: "0123456789abcdef" })),
    /PR マージ[\s\S]*0123456789ab/,
  );
});

test("uses the worker error and caps long failure lists", () => {
  assert.match(
    pullRequestLifecycleMessage("review_failed", pr({ checkStatus: "failed", error: "worker died" })),
    /worker died/,
  );
  const text = pullRequestLifecycleMessage("review_failed", pr({
    reasons: Array.from({ length: 8 }, (_, index) => `reason ${index + 1}`),
  }));
  assert.match(text, /reason 5/);
  assert.doesNotMatch(text, /reason 6/);
  assert.match(text, /ほか 3 件/);
});

test("keeps workstation absolute paths out of published failure reasons", () => {
  // worker の例外文はそのまま理由になる。ホームディレクトリ名は個人情報なので、
  // Discord へ出る前にディレクトリ部分を落とし、末尾の名前だけ残す。
  const windows = pullRequestLifecycleMessage("review_failed", pr({
    checkStatus: "failed",
    error: "git rev-parse failed: fatal: cannot change to 'C:\\Users\\someone\\Ars\\Product'",
  }));
  assert.doesNotMatch(windows, /someone/);
  assert.match(windows, /…\/Product/);

  const posix = pullRequestLifecycleMessage("review_failed", pr({
    reasons: ["ENOENT: no such file or directory, open '/home/someone/Ars/state.json'"],
  }));
  assert.doesNotMatch(posix, /someone/);
  assert.match(posix, /…\/state\.json/);

  // 相対パスと URL は診断に要るので触らない (絶対パスだけを落とす)。
  const kept = pullRequestLifecycleMessage("review_failed", pr({
    reasons: ["src/review-gate.mjs did not pass", "advisory: https://example.com/a/b"],
  }));
  assert.match(kept, /src\/review-gate\.mjs/);
  assert.match(kept, /https:\/\/example\.com\/a\/b/);
});

test("neutralizes Discord mentions and line breaks in author-controlled fields", () => {
  // 送信本文に残ってはいけないのは「素の」メンション。無害化済みのものは
  // ゼロ幅スペースを挟んだ形で残るので、先にそれを畳んでから素の形を探す。
  const raw = (text) => text.replaceAll(String.fromCharCode(0x200b), "");
  const neutralized = (text) => raw(text) !== text;

  const created = pullRequestLifecycleMessage("created", pr({
    title: "ping @everyone and @here",
    headRef: "feat/<@1234>",
  }));
  assert.ok(neutralized(created));
  assert.doesNotMatch(created, /@everyone/);
  assert.doesNotMatch(created, /@here/);
  assert.doesNotMatch(created, /<@1234>/);
  assert.match(raw(created), /ping @everyone and @here/);

  // 1 行 1 情報の体裁を改行の差し込みで崩されない。
  const multiline = pullRequestLifecycleMessage("created", pr({
    title: "line one\nline two",
    headRef: "feat/a\nb",
  }));
  assert.equal(multiline.split("\n").length, 4);

  const failed = pullRequestLifecycleMessage("review_failed", pr({
    checkStatus: "failed",
    error: "worker died\n@everyone look",
  }));
  assert.doesNotMatch(failed, /@everyone/);
  assert.match(failed, /- worker died @/);
});

test("publishes to the shared report channel as Revisor", async () => {
  let input;
  const sent = await notifyPullRequestLifecycle({
    event: "created",
    pullRequest: pr(),
    baseUrl: "http://127.0.0.1:11111",
    notify: async (value) => { input = value; return true; },
  });
  assert.equal(sent, true);
  assert.equal(input.channel, "報告");
  assert.equal(input.sessionId, "lictor-review");
  assert.equal(input.authorLabel, "Revisor");
  assert.match(input.text, /LUDIARS\/Revisor#12/);
});

test("does not publish a lifecycle notice for a sessionless PR", async () => {
  let called = false;
  const sent = await notifyPullRequestLifecycle({
    event: "created",
    pullRequest: pr({ sessionId: null }),
    baseUrl: "http://127.0.0.1:11111",
    notify: async () => {
      called = true;
      return true;
    },
  });
  assert.equal(sent, false);
  assert.equal(called, false);
});

test("a closed PR notice names the reason and says it was not merged", () => {
  const text = pullRequestLifecycleMessage("closed", pr({
    status: "closed",
    checkStatus: "test_ok",
    closeReason: "内容は既に main に入っている",
  }));
  assert.match(text, /取り下げ/);
  assert.match(text, /LUDIARS\/Revisor#12/);
  assert.match(text, /理由: 内容は既に main に入っている/);
  // マージ通知と取り違えられると、入ったものと入らなかったものが区別できなくなる。
  assert.match(text, /マージされていません/);
});

test("a closed PR notice is explicit when no reason was recorded", () => {
  const text = pullRequestLifecycleMessage("closed", pr({ status: "closed", closeReason: null }));
  assert.match(text, /理由の記録はありません/);
  assert.equal(pullRequestLifecycleTone("closed"), "warn");
});

test("a close reason cannot smuggle mentions, local details, or credentials into Discord", () => {
  const credential = ["ghp", "_", "a".repeat(24)].join("");
  const text = pullRequestLifecycleMessage("closed", pr({
    status: "closed",
    closeReason: `@everyone /home/someone/secret/notes.md を参照\nhttp://127.0.0.1:11111/private\n${credential}`,
  }));
  assert.doesNotMatch(text, /@everyone/);
  assert.doesNotMatch(text, /home\/someone/);
  assert.doesNotMatch(text, /127\.0\.0\.1/);
  assert.match(text, /\[redacted: private endpoint\]/);
  assert.doesNotMatch(text, new RegExp(credential));
  assert.match(text, /\[redacted: github-token\]/);
  assert.match(text, /…\/notes\.md/);
});
