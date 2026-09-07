import { rm } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "./process.mjs";
import { makeScratchDir } from "./scratch-space.mjs";

const SAFE_REF = /^(?![-/])(?!.*(?:\.\.|@\{|\/\/))[A-Za-z0-9._/-]+(?<!\/)$/;
const SAFE_SHA = /^[0-9a-fA-F]{7,64}$/;

// A repository whose `.gitattributes` declares `filter=lfs` routes checked-out
// content through the `filter.lfs.process` (or smudge/clean) command that
// `git lfs install` configures. Disposable Revisor worktrees only need the
// pointer-file bytes, so callers that own such a worktree may opt out explicitly.
export const NO_LFS_FILTER_ARGS = [
  "-c", "filter.lfs.process=",
  "-c", "filter.lfs.smudge=",
  "-c", "filter.lfs.clean=",
  "-c", "filter.lfs.required=false",
];

export function assertSafeRef(value, label) {
  if (!SAFE_REF.test(value)) throw new Error(`${label} is not a safe Git ref`);
}

// SHA は常に Git 自身の出力か state に記録された Git の出力だが、 それを argv や
// `a..b` の revision range に組み立てる境界では形を確かめてから渡す (`-` 始まりの
// 値が option として解釈される経路を残さない)。
export function assertSafeSha(value, label) {
  if (typeof value !== "string" || !SAFE_SHA.test(value)) {
    throw new Error(`${label} is not a Git object name`);
  }
}

async function runGit(cwd, args, timeoutMs, configArgs = []) {
  const result = await runProcess({
    command: "git",
    args: [...configArgs, ...args],
    cwd,
    timeoutMs,
  });
  if (!result.ok) {
    const error = new Error(`git ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`);
    // Some Git predicates use exit status 1 as a normal false result. Preserve
    // the status so callers can distinguish that from spawn, timeout, or
    // repository failures without parsing localized stderr.
    error.exitCode = result.exitCode;
    throw error;
  }
  return result.stdout.trim();
}

export function git(cwd, args, timeoutMs = 120_000) {
  return runGit(cwd, args, timeoutMs);
}

export function gitWithoutLfs(cwd, args, timeoutMs = 120_000) {
  return runGit(cwd, args, timeoutMs, NO_LFS_FILTER_ARGS);
}

function isUnavailableLfsFilter(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:git-lfs|git lfs|filter(?:\.|\s+|['"])+lfs|lfs filter)/i.test(message)
    && /(?:cannot|failed|fork|no such file|not found|not installed|not recognized|unable)/i.test(message);
}

async function gitWithLfsFallback(cwd, args, timeoutMs = 120_000) {
  try {
    return await git(cwd, args, timeoutMs);
  } catch (error) {
    if (!isUnavailableLfsFilter(error)) throw error;
    // A monitored checkout may have a working LFS filter and materialized
    // blobs, so never disable it pre-emptively. Falling back only after the
    // configured filter is unavailable preserves normal clean/smudge semantics.
    return gitWithoutLfs(cwd, args, timeoutMs);
  }
}

function parseWorktreeList(output) {
  return output
    .split(/\r?\n\r?\n/)
    .map((block) => Object.fromEntries(
      block.split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf(" ");
          return separator === -1
            ? [line, true]
            : [line.slice(0, separator), line.slice(separator + 1)];
        }),
    ))
    .filter((record) => typeof record.worktree === "string");
}

// Only tracked changes count as dirty, for both callers. A review reads a fixed
// SHA in a disposable worktree, so an untracked scratch file can never reach it;
// and a fast-forward ignores untracked files that do not collide, while Git
// itself aborts one that would overwrite them.
// A submodule's own uncommitted content belongs to that submodule, not to this
// PR: the parent still records the same commit, so neither the review nor the
// fast-forward is affected. A changed submodule *pointer* is a tracked change
// and is still reported.
export async function trackedChanges(worktreePath, { run = git } = {}) {
  const args = [
    "status",
    "--porcelain",
    "--untracked-files=no",
    "--ignore-submodules=dirty",
  ];
  return run === git ? gitWithLfsFallback(worktreePath, args) : run(worktreePath, args);
}

export async function branchWorktree(repoPath, ref, { run = git } = {}) {
  const branch = `refs/heads/${ref}`;
  const records = parseWorktreeList(await run(repoPath, ["worktree", "list", "--porcelain"]));
  return records.find((record) => record.branch === branch)?.worktree ?? null;
}

export async function isAncestor(repoPath, ancestor, descendant, { run = git } = {}) {
  try {
    await run(repoPath, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch (error) {
    if (error?.exitCode === 1) return false;
    throw error;
  }
}

async function assertHeadWorktreeClean(repoPath, headRef) {
  const checkedOutAt = await branchWorktree(repoPath, headRef);
  if (!checkedOutAt) return;
  const status = await trackedChanges(checkedOutAt);
  if (status) {
    throw new Error(
      `The head branch worktree has uncommitted changes: ${checkedOutAt}`,
    );
  }
}

/**
 * 審査に渡す差分の起点を解決する。
 *
 * head は登録元 checkout から読み、 **base は登録元から読まない**。 登録元の base ref は
 * `spec/feature/checkout-publication.md` の条件を満たすまで追随せず、 実際に squash 先と
 * なる位置より古いところに留まりうる。 そこを起点にすると、 他 PR がマージしたぶんまで
 * この PR の変更として審査へ渡ってしまう (`spec/feature/review-diff-scope.md`)。 base は
 * squash 先そのもの (merge repository) の ref から読み、 merge-base もそのリポジトリで
 * 求める。 merge-base は head の祖先なので、 登録元 checkout にも必ず存在し、 使い捨て
 * worktree はそちらに作れる。
 */
export async function resolveReviewDiffOrigin({
  sourceRepoPath,
  baseRepoPath,
  headRef,
  baseRef,
}) {
  assertSafeRef(headRef, "head_ref");
  assertSafeRef(baseRef, "base_ref");
  if (headRef === baseRef) throw new Error("head_ref and base_ref must differ.");
  const headSha = await git(sourceRepoPath, ["rev-parse", "--verify", `refs/heads/${headRef}`]);
  const baseSha = await git(baseRepoPath, ["rev-parse", "--verify", `refs/heads/${baseRef}`]);
  if (headSha === baseSha) throw new Error("The local PR has no commits to review.");
  await assertHeadWorktreeClean(sourceRepoPath, headRef);
  return {
    headSha,
    baseSha,
    mergeBase: await git(baseRepoPath, ["merge-base", headSha, baseSha]),
  };
}

/**
 * 1 つのリポジトリだけを見る解決。 投稿時の記録 (`baseSha`) と再投入の再解決に使う。
 * 審査の差分起点にはこれを使わない — `resolveReviewDiffOrigin` を使うこと。
 */
export function inspectLocalPullRequest(repoPath, headRef, baseRef) {
  return resolveReviewDiffOrigin({
    sourceRepoPath: repoPath,
    baseRepoPath: repoPath,
    headRef,
    baseRef,
  });
}

/**
 * 審査用の使い捨て worktree を作る。
 *
 * `request.rootPath` は登録元 checkout (head の在処であり、 autofix の反映先)、
 * `request.reviewRootPath` は差分の起点となる base ref を持つ merge repository。
 * 後者が無いまま審査を走らせると起点が登録元へ戻ってしまうので、 省略は許さない。
 *
 * `settings.reviewScratchRoot` は worktree を置く親ディレクトリ。 省略した呼び出しは
 * OS の一時領域へ落ちる (`spec/feature/local-workspace.md` SPEC-REVIEW-SCRATCH-ROOT)。
 */
export async function prepareLocalWorktrees(request, settings = {}) {
  const repoPath = request.rootPath;
  if (typeof repoPath !== "string" || !repoPath.trim()) {
    throw new TypeError("A review request must carry the registered repository root path.");
  }
  if (typeof request.reviewRootPath !== "string" || !request.reviewRootPath.trim()) {
    throw new TypeError(
      "A review request must carry the merge repository path that defines the diff origin.",
    );
  }
  const inspected = await resolveReviewDiffOrigin({
    sourceRepoPath: repoPath,
    baseRepoPath: request.reviewRootPath,
    headRef: request.headRef,
    baseRef: request.baseRef,
  });
  if (inspected.headSha.toLowerCase() !== request.headSha.toLowerCase()) {
    throw new Error(
      `head SHA changed before review (expected ${request.headSha}, found ${inspected.headSha})`,
    );
  }
  const root = await makeScratchDir("revisor-local-pr-", settings);
  const worktrees = {
    root,
    head: join(root, "head"),
    base: join(root, "base"),
    mergeBase: inspected.mergeBase,
  };
  try {
    await gitWithoutLfs(repoPath, ["worktree", "add", "--detach", worktrees.head, inspected.headSha]);
    await gitWithoutLfs(repoPath, ["worktree", "add", "--detach", worktrees.base, inspected.mergeBase]);
    return worktrees;
  } catch (error) {
    await cleanupWorktrees(repoPath, worktrees);
    throw error;
  }
}

// merge-base からの差分の安定指紋。rebase で SHA が変わっても差分内容が同じなら
// 一致する (git patch-id --stable)。差分が空なら空文字。
export async function diffPatchId(repoPath, sha, baseSha) {
  assertSafeSha(sha, "sha");
  assertSafeSha(baseSha, "base sha");
  const mergeBase = await git(repoPath, ["merge-base", sha, baseSha]);
  const diff = await runProcess({
    command: "git",
    args: ["diff", `${mergeBase}..${sha}`],
    cwd: repoPath,
    timeoutMs: 120_000,
  });
  if (!diff.ok) {
    throw new Error(`git diff failed: ${diff.stderr.trim() || diff.stdout.trim()}`);
  }
  if (!diff.stdout.trim()) return "";
  const result = await runProcess({
    command: "git",
    args: ["patch-id", "--stable"],
    cwd: repoPath,
    stdin: diff.stdout,
    timeoutMs: 120_000,
  });
  if (!result.ok) {
    throw new Error(`git patch-id failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  const patchId = result.stdout.trim().split(/\s+/)[0] ?? "";
  if (!patchId) {
    // 非空の差分なのに指紋が取れない (binary だけの差分など)。 ここで空文字を返すと
    // 内容の違う 2 つのヘッドが「同じ指紋」に見えてしまうので、比較不能として投げる。
    throw new Error("git patch-id produced no identifier for a non-empty diff.");
  }
  return patchId;
}

/** autofix コミットの目印。 `commitAndAdvanceAutofix` が trailer として必ず書く。 */
export const AUTOFIX_TRAILER = "Revisor-Autofix: true";

// 目印は **trailer 行そのもの**としてだけ認める。 本文のどこかに現れる部分文字列で
// 判定すると、 この機能を説明する commit や task md を引用した提出者のコミットが
// 自己要因に化ける (この repository の履歴には実際にその文字列が載る)。
const AUTOFIX_TRAILER_LINE = new RegExp(
  `^${AUTOFIX_TRAILER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
);

function hasAutofixTrailer(body) {
  return body.split(/\r?\n/).some((line) => AUTOFIX_TRAILER_LINE.test(line.trim()));
}

/**
 * `expectedSha..currentSha` の全コミットが Revisor 自身の autofix か。
 *
 * 空 (= 進んでいない) なら false を返す — 呼び出し側は先に一致判定を済ませている前提で、
 * 「進んでいないのに自己要因」という判定を作らない。 range が引けない (片方が到達不能
 * など) 場合も false = 外部要因扱いにする。 判定不能を自己要因へ倒すと、 提出者が足した
 * コミットを黙って飲み込む経路になる。
 */
export async function revisorAutofixOnly(repoPath, expectedSha, currentSha, { run = git } = {}) {
  assertSafeSha(expectedSha, "expected sha");
  assertSafeSha(currentSha, "current sha");
  let log;
  try {
    // 1 コミット 1 レコードを NUL で区切る。 %B (本文) は空にもなりうるので、 レコード数を
    // 数えられるよう %H を先頭に置く。 本文が空のコミットを「無かったこと」にすると、
    // メッセージ無しで積まれた提出者のコミットが黙って通る。
    log = await run(repoPath, ["log", "--format=%H%n%B%x00", `${expectedSha}..${currentSha}`]);
  } catch {
    return false;
  }
  // レコード間の区切りは NUL。 各レコードの先頭行が %H で、 残りが本文。 レコードの前後には
  // 改行が付きうるので、 SHA 行は位置ではなく「最初の非空行」として落とす。
  const records = log.split("\0").filter((record) => record.trim());
  if (records.length === 0) return false;
  return records.every((record) => {
    const lines = record.split(/\r?\n/);
    const shaLine = lines.findIndex((line) => line.trim());
    return hasAutofixTrailer(lines.slice(shaLine + 1).join("\n"));
  });
}

/**
 * 審査中にブランチが動いていないことを確かめてから ff で進める。
 *
 * ガード自体は正しい (提出者が提出後にコミットを足す事故を止める) が、 **Revisor 自身の
 * autofix コミットまで外部変更として弾いていた**。 autofix が入る PR は必ず一度
 * `checkStatus: failed` になり、 人手の `pr retry --force` が要る状態だった
 * (2026-09-05 に 1 日 4 件、 うち 2 件が autofix 起因)。
 *
 * そこで「期待 head からの差分が Revisor 自身の autofix コミットだけか」を見る。
 * 自己要因なら現在の tip を新しい期待 head として審査を続行する。 外部要因は従来どおり
 * 失敗させ、 **文面を分けて**受け取った側が原因を切り分けられるようにする。
 */
export async function advanceLocalBranch(repoPath, ref, expectedSha, nextSha, { run = git } = {}) {
  assertSafeRef(ref, "branch");
  let current = await run(repoPath, ["rev-parse", "--verify", `refs/heads/${ref}`]);
  if (current.toLowerCase() !== expectedSha.toLowerCase()) {
    if (!(await revisorAutofixOnly(repoPath, expectedSha, current, { run }))) {
      throw new Error(
        `Local branch '${ref}' changed while Revisor was working `
        + `(external commits were added on top of ${expectedSha}).`,
      );
    }
    // 自分の autofix で進んだだけ。 ただし進める先がその上に載っていなければ ff できず、
    // 無理に進めると autofix を取りこぼす。 到達関係を確かめてから続行する。
    if (nextSha.toLowerCase() === current.toLowerCase()
      || await isAncestor(repoPath, nextSha, current, { run })) {
      // 既に反映済み (再入 / 再試行)。 これ以上進めるものは無い。
      return current;
    }
    if (!(await isAncestor(repoPath, current, nextSha, { run }))) {
      throw new Error(
        `Local branch '${ref}' advanced by Revisor's own autofix to ${current}, `
        + `but ${nextSha} is not built on it; refusing to drop the autofix commits.`,
      );
    }
    expectedSha = current;
  }
  if (current.toLowerCase() === nextSha.toLowerCase()) return nextSha;
  const checkedOutAt = await branchWorktree(repoPath, ref, { run });
  if (!checkedOutAt) {
    await run(repoPath, [
      "update-ref",
      `refs/heads/${ref}`,
      nextSha,
      expectedSha,
    ]);
    return nextSha;
  }
  const status = await trackedChanges(checkedOutAt, { run });
  if (status) {
    throw new Error(`Cannot advance '${ref}'; its worktree is no longer clean.`);
  }
  if (run === git) {
    await gitWithLfsFallback(checkedOutAt, ["merge", "--ff-only", nextSha]);
  } else {
    await run(checkedOutAt, ["merge", "--ff-only", nextSha]);
  }
  return nextSha;
}

// Windows では Defender の on-access スキャンや消えかけの子プロセスが一時的に
// ハンドルを掴み、rmdir が EBUSY/EPERM になる。maxRetries で待つ。
function removeTempRoot(root) {
  return rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

export async function cleanupWorktrees(repoPath, worktrees, { removeRoot = removeTempRoot } = {}) {
  for (const path of [worktrees.head, worktrees.base]) {
    try {
      await git(repoPath, ["worktree", "remove", "--force", path]);
    } catch {
      // Partial setup may not have registered both disposable worktrees.
    }
  }
  try {
    await git(repoPath, ["worktree", "prune"]);
  } catch {
    // Cleanup is best-effort after individual worktree removal attempts.
  }
  try {
    await removeRoot(worktrees.root);
  } catch {
    // それでも消せない場合に review job を落とさない。失敗扱いのレビューは有害
    // (2026-08-02 に EBUSY が同一 PR の審査を 2 回落とした) 一方、残る temp dir は
    // worktree を外した後の Git 管理外コピーなので無害。Revisor は残骸を再掃除しない。
    // OS の temp 掃除か手動削除に委ねる。
  }
}
