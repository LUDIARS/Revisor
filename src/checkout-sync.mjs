import { assertSafeRef, assertSafeSha, branchWorktree, git, isAncestor, trackedChanges } from "./workspace.mjs";
import { redactSecretLines } from "./leakage.mjs";

/**
 * マージ後、 登録 checkout の base branch に実際その変更が入ったかを見る。
 *
 * `advanceLocalBranch` は fast-forward できないと throw するが、 **PR の記録は
 * その手前で `merged` として確定している**。 その結果「マージ済み・mergeError なし・
 * けれど登録 checkout には入っていない」状態が生まれ、 提出した側からは成功にしか
 * 見えない。 複数 repository が古い base のまま作業を続けた実例がある。
 *
 * ここは **判定して記録するだけ**で、 直さない。 直すには汚れた worktree を捨てるか
 * 履歴を書き換えるかで、 どちらも人が決めることだから。 マージ自体は成功しており
 * 公開も済んでいるので、 ここの結果でマージを失敗にはしない。
 */

/** 同期していない理由。 直し方が違うので区別する。 */
export const CHECKOUT_SYNC_STATES = /** @type {const} */ ([
  "in_sync",
  "worktree_dirty",
  "not_fast_forward",
  "missing_commit",
  "unknown",
]);

const REASON_TEXT = {
  in_sync: "登録 checkout の base にマージが入っている",
  worktree_dirty:
    "登録 checkout に追跡ファイルの変更が残っていて base を進められない"
    + " (マージが触っていないファイルでも拒否される)",
  not_fast_forward:
    "マージコミットが登録 checkout の base の子孫でないため fast-forward できない",
  missing_commit: "マージコミットが登録 checkout に無い",
  unknown: "判定できなかった",
};

const MAX_DETAIL_LENGTH = 2_000;
const PRIVATE_ENDPOINT =
  /\bhttps?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|\[::1\]|[^\s/:]+\.local)(?::\d+)?(?=\/|\s|$)(?:\/[^\s]*)?/gi;
const ABSOLUTE_PATH =
  /(?:(?<![A-Za-z0-9])[A-Za-z]:[\\/]|(?<=^|[\s"'(=])\/)(?:[^\s"'(),;]*[\\/])+([^\s"'(),;]*)/g;

export function describeCheckoutSync(state) {
  return REASON_TEXT[state] ?? REASON_TEXT.unknown;
}

/**
 * @param {object} input
 * @param {string} input.repoPath 登録 checkout のパス
 * @param {string} input.baseRef マージ先ブランチ名
 * @param {string} input.mergeCommitSha 入っているべきコミット
 * @returns {Promise<{state: string, detail: string, baseSha: string|null}>}
 */
export async function inspectCheckoutSync({ repoPath, baseRef, mergeCommitSha, run = git }) {
  assertSafeRef(baseRef, "base_ref");
  assertSafeSha(mergeCommitSha, "merge commit sha");

  let baseSha = null;
  try {
    baseSha = (await run(repoPath, ["rev-parse", `refs/heads/${baseRef}`])).trim();
    assertSafeSha(baseSha, "base branch sha");
  } catch (error) {
    // base branch が読めない時点で同期の判定はできない。 マージの成否とは別の話なので
    // ここで例外にせず unknown を返す。
    return { state: "unknown", detail: sanitizeCheckoutSyncDetail(error), baseSha: null };
  }

  // 入っているなら理由を調べる必要はない。 いちばん多い経路なので最初に見る。
  try {
    if (await isAncestor(repoPath, mergeCommitSha, baseSha, { run })) {
      return { state: "in_sync", detail: "", baseSha };
    }
  } catch (error) {
    return { state: "unknown", detail: sanitizeCheckoutSyncDetail(error), baseSha };
  }

  // コミット自体が無い場合と、 あるが載っていない場合を区別する。 前者は公開経路の
  // 問題で、 後者は登録 checkout の状態の問題。
  try {
    await run(repoPath, ["cat-file", "-e", `${mergeCommitSha}^{commit}`]);
  } catch (error) {
    // A missing object is a normal Git rejection. A process that could not run
    // or timed out did not establish absence and must remain unknown.
    if (error?.exitCode === null) {
      return { state: "unknown", detail: sanitizeCheckoutSyncDetail(error), baseSha };
    }
    return { state: "missing_commit", detail: describeCheckoutSync("missing_commit"), baseSha };
  }

  // worktree が汚れていると `advanceLocalBranch` は ff を試す前に拒否する。
  // 同じ順序で見ないと、 報告する理由が実際の失敗理由とずれる。
  try {
    const worktreePath = await branchWorktree(repoPath, baseRef, { run });
    if (worktreePath) {
      const changes = await trackedChanges(worktreePath, { run });
      if (changes) {
        return {
          state: "worktree_dirty",
          detail: sanitizeCheckoutSyncDetail(
            `${describeCheckoutSync("worktree_dirty")}: ${firstLines(changes, 5)}`,
          ),
          baseSha,
        };
      }
    }
  } catch (error) {
    return { state: "unknown", detail: sanitizeCheckoutSyncDetail(error), baseSha };
  }

  return { state: "not_fast_forward", detail: describeCheckoutSync("not_fast_forward"), baseSha };
}

export function sanitizeCheckoutSyncDetail(value) {
  const text = value instanceof Error ? value.message : String(value ?? "");
  const redacted = redactSecretLines(text)
    .replace(PRIVATE_ENDPOINT, "[redacted: private endpoint]")
    .replace(ABSOLUTE_PATH, (_match, tail) => `…/${tail}`)
    .replace(/\s+/g, " ")
    .trim();
  return redacted.length <= MAX_DETAIL_LENGTH
    ? redacted
    : `${redacted.slice(0, MAX_DETAIL_LENGTH)}[truncated]`;
}

function firstLines(text, limit) {
  const lines = String(text).split("\n").filter((line) => line.trim());
  const head = lines.slice(0, limit).join(" / ");
  return lines.length > limit ? `${head} (ほか ${lines.length - limit} 件)` : head;
}
