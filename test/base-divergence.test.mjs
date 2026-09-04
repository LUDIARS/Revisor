import assert from "node:assert/strict";
import test from "node:test";
import {
  blocksReview,
  describeDivergence,
  inspectBaseDivergence,
  needsAttention,
} from "../src/base-divergence.mjs";

const ROOT = "/workspace/Product";
const LOCAL = "a".repeat(40);
const REMOTE = "b".repeat(40);

/** `git` の差し替え。 コマンド全体 → 先頭 2 語 → 先頭 1 語 の順に応答を引く。 */
function fakeGit(responses = {}, { fail = new Set() } = {}) {
  const calls = [];
  const run = async (repoPath, args) => {
    calls.push(args.join(" "));
    const command = args.join(" ");
    const key = args.slice(0, 2).join(" ");
    const failedKey = [command, key, args[0]].find((candidate) => fail.has(candidate));
    if (failedKey !== undefined) {
      const error = new Error(`git ${key} failed`);
      error.exitCode = fail instanceof Map ? fail.get(failedKey) : null;
      throw error;
    }
    if (responses[command] !== undefined) return responses[command];
    if (responses[key] !== undefined) return responses[key];
    return responses[args[0]] ?? "";
  };
  run.calls = calls;
  return run;
}

const inspect = (run) => inspectBaseDivergence({ rootPath: ROOT, baseRef: "main", run });

test("一致していれば in_sync", async () => {
  const run = fakeGit({ "show-ref": "", "rev-parse": `${LOCAL}\n` });
  const result = await inspect(run);

  assert.equal(result.state, "in_sync");
  // 一致した時点で数える必要はない。 余計な git を叩かない。
  assert.ok(!run.calls.some((call) => call.startsWith("rev-list")));
});

test("ローカルだけ先行なら ahead (Revisor の通常形なので審査を止めない)", async () => {
  const run = fakeGit({
    "rev-parse --verify refs/heads/main": `${LOCAL}\n`,
    "rev-parse --verify refs/remotes/origin/main": `${REMOTE}\n`,
    "rev-list --count refs/remotes/origin/main..refs/heads/main": "3\n",
    "rev-list --count refs/heads/main..refs/remotes/origin/main": "0\n",
    "diff --name-only": "a.ts\0b.ts\0",
  });
  const result = await inspect(run);

  assert.equal(result.state, "ahead");
  assert.equal(result.ahead, 3);
  assert.equal(result.changedFiles, 2);
  assert.equal(blocksReview(result.state), false);
});

test("リモートだけ先行なら behind (審査の base が古い)", async () => {
  const run = fakeGit({
    "rev-parse --verify refs/heads/main": `${LOCAL}\n`,
    "rev-parse --verify refs/remotes/origin/main": `${REMOTE}\n`,
    "rev-list --count refs/remotes/origin/main..refs/heads/main": "0\n",
    "rev-list --count refs/heads/main..refs/remotes/origin/main": "4\n",
  });
  const result = await inspect(run);

  assert.equal(result.state, "behind");
  assert.equal(result.behind, 4);
  assert.equal(blocksReview(result.state), true);
});

test("双方向なら diverged (ff できないので判断が要る)", async () => {
  const run = fakeGit({
    "rev-parse --verify refs/heads/main": `${LOCAL}\n`,
    "rev-parse --verify refs/remotes/origin/main": `${REMOTE}\n`,
    "rev-list --count refs/remotes/origin/main..refs/heads/main": "1\n",
    "rev-list --count refs/heads/main..refs/remotes/origin/main": "7\n",
  });
  const result = await inspect(run);

  assert.equal(result.state, "diverged");
  assert.equal(blocksReview(result.state), true);
});

test("先行していても内容差 0 を見分けられる (登録時コミットだけの場合)", async () => {
  // .revisor-version だけの bootstrap コミットは実体が同じなので直す必要が無い。
  const run = fakeGit({
    "rev-parse --verify refs/heads/main": `${LOCAL}\n`,
    "rev-parse --verify refs/remotes/origin/main": `${REMOTE}\n`,
    "rev-list --count refs/remotes/origin/main..refs/heads/main": "1\n",
    "rev-list --count refs/heads/main..refs/remotes/origin/main": "0\n",
    "diff --name-only": "",
  });

  assert.equal((await inspect(run)).changedFiles, 0);
});

test("追跡 ref が無い登録は乖離にしない", async () => {
  // origin を持たないローカル専用リポは乖離しようがない。 失敗でもない。
  const run = fakeGit({}, { fail: new Map([["show-ref --verify --quiet refs/remotes/origin/main", 1]]) });
  const result = await inspect(run);

  assert.equal(result.state, "no_remote_ref");
  assert.equal(blocksReview(result.state), false);
});

test("fetch しない (読み取り専用)", async () => {
  // 共有 checkout に対する照会なので、 ネットワークにも参照にも触らない。
  const run = fakeGit({ "show-ref": "", "rev-parse": `${LOCAL}\n` });
  await inspect(run);

  assert.ok(!run.calls.some((call) => call.startsWith("fetch")));
});

test("数え方が壊れても状態は返す", async () => {
  const run = fakeGit({
    "rev-parse --verify refs/heads/main": `${LOCAL}\n`,
    "rev-parse --verify refs/remotes/origin/main": `${REMOTE}\n`,
  }, { fail: new Set(["rev-list"]) });

  assert.equal((await inspect(run)).state, "unknown");
});

test("状態には人が読める説明がある", () => {
  for (const state of ["in_sync", "ahead", "behind", "diverged", "no_remote_ref", "unknown"]) {
    assert.ok(describeDivergence(state).length > 0, state);
  }
});

test("追跡 ref の確認自体が壊れた場合は ref 不在に偽装せず詳細も漏らさない", async () => {
  const error = new Error("internal git diagnostic");
  error.exitCode = null;
  const result = await inspect(async () => { throw error; });

  assert.equal(result.state, "unknown");
  assert.equal(result.detail, describeDivergence("unknown"));
  assert.doesNotMatch(result.detail, /diagnostic/);
  assert.equal(needsAttention(result.state), true);
});

test("不正な commit 数を behind と誤判定しない", async () => {
  const run = fakeGit({
    "rev-parse --verify refs/heads/main": `${LOCAL}\n`,
    "rev-parse --verify refs/remotes/origin/main": `${REMOTE}\n`,
    "rev-list --count refs/remotes/origin/main..refs/heads/main": "not-a-number\n",
  });

  assert.equal((await inspect(run)).state, "unknown");
});

test("改行を含むファイル名も 1 件として数える", async () => {
  const run = fakeGit({
    "rev-parse --verify refs/heads/main": `${LOCAL}\n`,
    "rev-parse --verify refs/remotes/origin/main": `${REMOTE}\n`,
    "rev-list --count refs/remotes/origin/main..refs/heads/main": "1\n",
    "rev-list --count refs/heads/main..refs/remotes/origin/main": "0\n",
    "diff --name-only": "line\nbreak.txt\0plain.txt\0",
  });

  assert.equal((await inspect(run)).changedFiles, 2);
});
