import assert from "node:assert/strict";
import test from "node:test";
import { syncSourceCheckout } from "../src/source-checkout-sync.mjs";

/**
 * `git` の差し替え。呼ばれたコマンドを記録し、応答は完全一致、次に先頭語 + 第 2 語で引く。
 * 応答が無いものは空文字 (status が clean、fetch が無出力、等) を返す。
 */
function fakeGit(responses = {}, { fail = new Set() } = {}) {
  const calls = [];
  const run = async (repoPath, args) => {
    calls.push({ repoPath, args: args.join(" ") });
    const command = args.join(" ");
    const key = args.slice(0, 2).join(" ");
    if (fail.has(key) || fail.has(args[0])) throw new Error(`git ${key} failed`);
    if (args[0] === "rev-parse" && args[1] === "--verify"
      && args[2]?.startsWith("refs/revisor/source-checkout-sync/")) {
      return responses["rev-parse fetched"] ?? "";
    }
    return responses[command] ?? responses[key] ?? responses[args[0]] ?? "";
  };
  run.calls = calls;
  return run;
}

const SOURCE = "/workspace/Product";
const MERGE = "/state/merge-repositories/ludiars-product-abc";

function inputs(overrides = {}) {
  return { sourceRootPath: SOURCE, mergeRootPath: MERGE, baseRef: "main", ...overrides };
}

test("fast-forwards the checked-out base when the tree is clean", async () => {
  const run = fakeGit({
    "rev-parse --verify": "aaa",
    "rev-parse fetched": "bbb",
    "worktree list": `worktree ${SOURCE}\nHEAD aaa\nbranch refs/heads/main\n`,
    "status --porcelain": "",
  });
  const result = await syncSourceCheckout({ ...inputs(), run });
  assert.deepEqual(result, { synced: true, from: "aaa", to: "bbb" });
  assert.ok(run.calls.some((call) => call.args.startsWith("merge --ff-only bbb")));
  assert.ok(run.calls.some((call) => /fetch --no-tags -- .*refs\/heads\/main:refs\/revisor\/source-checkout-sync\//.test(call.args)));
  assert.ok(!run.calls.some((call) => call.args === "rev-parse FETCH_HEAD"));
});

// Revisor が止まっている間に checkout へ直接当てられたコミットが base に載っていることがある
// (2026-08-09 の Concordia `merge/cc-batch-main`)。追随を強制すればその分を捨てるので、
// ff が成立しない時点で手を引く。
test("leaves a base that has local commits the merge result lacks", async () => {
  const run = fakeGit({
    "rev-parse --verify": "local-ahead",
    "rev-parse fetched": "published",
    "status --porcelain": "",
  }, { fail: new Set(["merge-base --is-ancestor"]) });
  const result = await syncSourceCheckout({ ...inputs(), run });
  assert.equal(result.synced, false);
  assert.match(result.reason, /local commits/);
  assert.ok(!run.calls.some((call) => call.args.startsWith("merge --ff-only")));
  assert.ok(!run.calls.some((call) => call.args.startsWith("update-ref refs/heads/")));
});

// 作業ツリーを動かす経路なので、未コミットがあるときに触ってはいけない。
test("leaves a checked-out base alone when the tree is dirty", async () => {
  const run = fakeGit({
    "rev-parse --verify": "aaa",
    "rev-parse fetched": "bbb",
    "worktree list": `worktree ${SOURCE}\nHEAD aaa\nbranch refs/heads/main\n`,
    "status --porcelain": " M src/thing.ts",
  });
  const result = await syncSourceCheckout({ ...inputs(), run });
  assert.equal(result.synced, false);
  // 文言は「どの branch のどこが問題か」を名指しする形になった (da77a05)。
  assert.match(result.reason, /worktree is no longer clean/);
  assert.ok(!run.calls.some((call) => call.args.startsWith("merge --ff-only")));
});

// checkout されていない branch は ref 更新だけで足りる (作業ツリーに触れない)。
test("updates the ref without touching the tree when the base is not checked out", async () => {
  const run = fakeGit({
    "rev-parse --verify": "aaa",
    "rev-parse fetched": "bbb",
  });
  const result = await syncSourceCheckout({ ...inputs(), run });
  assert.equal(result.synced, true);
  assert.ok(run.calls.some((call) => call.args === "update-ref refs/heads/main bbb aaa"));
  assert.ok(!run.calls.some((call) => call.args.startsWith("status --porcelain")));
});

test("does nothing when the base already matches the merge result", async () => {
  const run = fakeGit({
    "rev-parse --verify": "same",
    "rev-parse fetched": "same",
  });
  const result = await syncSourceCheckout({ ...inputs(), run });
  assert.deepEqual(result, { synced: false, reason: "already up to date" });
});

test("does nothing when the source checkout is the merge checkout", async () => {
  const run = fakeGit();
  const result = await syncSourceCheckout({ ...inputs({ mergeRootPath: SOURCE }), run });
  assert.equal(result.synced, false);
  assert.equal(run.calls.length, 0);
});

test("rejects an unsafe base ref before invoking Git", async () => {
  const run = fakeGit();
  const result = await syncSourceCheckout({ ...inputs({ baseRef: "--upload-pack=cmd" }), run });
  assert.equal(result.synced, false);
  assert.match(result.reason, /safe Git ref/);
  assert.equal(run.calls.length, 0);
});

test("rejects a non-local merge repository before invoking Git", async () => {
  const run = fakeGit();
  const result = await syncSourceCheckout({ ...inputs({ mergeRootPath: "ext::helper" }), run });
  assert.equal(result.synced, false);
  assert.match(result.reason, /paths must be absolute/);
  assert.equal(run.calls.length, 0);
});

// マージは既に成立している。 同期の失敗で例外を投げるとマージが失敗扱いになる。
test("reports a git failure instead of throwing", async () => {
  const run = fakeGit({}, { fail: new Set(["fetch"]) });
  const result = await syncSourceCheckout({ ...inputs(), run });
  assert.equal(result.synced, false);
  // 失敗した git コマンドをそのまま名指しする (da77a05)。
  assert.match(result.reason, /git fetch --no-tags failed/);
});
