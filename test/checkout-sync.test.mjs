import assert from "node:assert/strict";
import test from "node:test";
import {
  describeCheckoutSync,
  inspectCheckoutSync,
  sanitizeCheckoutSyncDetail,
} from "../src/checkout-sync.mjs";

const REPO = "/workspace/Product";
const MERGE_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);

/**
 * `git` の差し替え。 コマンド全体 → 先頭 2 語 → 先頭 1 語 の順に応答を引き、
 * `fail` に入れた鍵は例外にする (`merge-base --is-ancestor` の失敗 = 祖先でない、等)。
 */
function fakeGit(responses = {}, { fail = new Set() } = {}) {
  const calls = [];
  const run = async (repoPath, args) => {
    calls.push(args.join(" "));
    const command = args.join(" ");
    const key = args.slice(0, 2).join(" ");
    if (fail.has(command) || fail.has(key) || fail.has(args[0])) {
      const error = new Error(`git ${key} failed`);
      error.exitCode = 1;
      throw error;
    }
    return responses[command] ?? responses[key] ?? responses[args[0]] ?? "";
  };
  run.calls = calls;
  return run;
}

function inspect(run) {
  return inspectCheckoutSync({ repoPath: REPO, baseRef: "main", mergeCommitSha: MERGE_SHA, run });
}

test("base がマージを含んでいれば in_sync", async () => {
  const run = fakeGit({ "rev-parse": `${BASE_SHA}\n` });
  const result = await inspect(run);

  assert.equal(result.state, "in_sync");
  assert.equal(result.baseSha, BASE_SHA);
  // 含んでいる時点で理由を調べる必要はない。 余計な git を叩かない。
  assert.ok(!run.calls.some((call) => call.startsWith("worktree list")));
});

test("worktree が汚れていれば worktree_dirty (ff を試す前に拒否される経路)", async () => {
  const run = fakeGit({
    "rev-parse": `${BASE_SHA}\n`,
    "worktree list": "worktree /workspace/Product\nbranch refs/heads/main\n",
    "status --porcelain": " M server/package-lock.json\n",
  }, { fail: new Set(["merge-base --is-ancestor"]) });

  const result = await inspect(run);
  assert.equal(result.state, "worktree_dirty");
  // マージが触っていないファイルでも拒否されるので、 どのファイルかを出す。
  assert.match(result.detail, /server\/package-lock\.json/);
});

test("worktree が綺麗なら not_fast_forward", async () => {
  const run = fakeGit({
    "rev-parse": `${BASE_SHA}\n`,
    "worktree list": "worktree /workspace/Product\nbranch refs/heads/main\n",
    "status --porcelain": "",
  }, { fail: new Set(["merge-base --is-ancestor"]) });

  assert.equal((await inspect(run)).state, "not_fast_forward");
});

test("branch が checkout されていなくても判定できる", async () => {
  // bare / worktree 未展開でも update-ref 経路で進むので、 dirty ではない。
  const run = fakeGit({
    "rev-parse": `${BASE_SHA}\n`,
    "worktree list": "worktree /workspace/Product\nbranch refs/heads/other\n",
  }, { fail: new Set(["merge-base --is-ancestor"]) });

  assert.equal((await inspect(run)).state, "not_fast_forward");
});

test("マージコミット自体が無ければ missing_commit", async () => {
  // 公開経路の問題と登録 checkout の状態の問題は直し方が違う。
  const run = fakeGit({ "rev-parse": `${BASE_SHA}\n` }, {
    fail: new Set(["merge-base --is-ancestor", "cat-file"]),
  });

  assert.equal((await inspect(run)).state, "missing_commit");
});

test("コミット確認プロセスが失敗したときは missing_commit と断定しない", async () => {
  const run = async (_repoPath, args) => {
    if (args[0] === "rev-parse") return `${BASE_SHA}\n`;
    const error = new Error(`git ${args[0]} failed: process timed out`);
    error.exitCode = args[0] === "merge-base" ? 1 : null;
    throw error;
  };

  const result = await inspect(run);
  assert.equal(result.state, "unknown");
  assert.match(result.detail, /timed out/);
});

test("base branch が読めなければ unknown (マージの失敗にしない)", async () => {
  const run = fakeGit({}, { fail: new Set(["rev-parse"]) });
  const result = await inspect(run);

  assert.equal(result.state, "unknown");
  assert.equal(result.baseSha, null);
});

test("祖先判定そのものが失敗したときは分岐と誤認せず unknown", async () => {
  const run = async (_repoPath, args) => {
    if (args[0] === "rev-parse") return `${BASE_SHA}\n`;
    const error = new Error("git merge-base failed: process timed out");
    error.exitCode = null;
    throw error;
  };

  const result = await inspect(run);
  assert.equal(result.state, "unknown");
  assert.match(result.detail, /timed out/);
});

test("永続化する診断から秘密・private endpoint・ローカルパスを除き長さを制限する", () => {
  const token = `ghp_${"x".repeat(24)}`;
  const detail = sanitizeCheckoutSyncDetail(
    `failure ${token}\nhttp://127.0.0.1:17332/private C:\\Users\\alice\\Product\\state.json ${"z".repeat(3_000)}`,
  );

  assert.equal(detail.includes(token), false);
  assert.equal(detail.includes("127.0.0.1"), false);
  assert.equal(detail.includes("alice"), false);
  assert.ok(detail.length < 2_100);
});

test("ref 名と sha は検証する", async () => {
  const run = fakeGit();
  await assert.rejects(
    () => inspectCheckoutSync({ repoPath: REPO, baseRef: "--upload-pack=x", mergeCommitSha: MERGE_SHA, run }),
  );
  await assert.rejects(
    () => inspectCheckoutSync({ repoPath: REPO, baseRef: "main", mergeCommitSha: "not-a-sha", run }),
  );
});

test("状態には人が読める説明がある", () => {
  for (const state of ["in_sync", "worktree_dirty", "not_fast_forward", "missing_commit", "unknown"]) {
    assert.ok(describeCheckoutSync(state).length > 0, state);
  }
});
