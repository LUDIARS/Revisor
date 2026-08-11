import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { MergeConflictError } from "./errors.mjs";
import { relandHeadOnBase } from "./base-relanding.mjs";
import { assertSafeRef, assertSafeSha, cleanupWorktrees, git } from "./workspace.mjs";

/**
 * 提出時に「現在の base へ載るか」だけを先に見る。
 *
 * 載せ替え自体は取り込み時に Revisor が行う (`review-diff-scope.md` 規則 3) ので、
 * ここでやるのは判定だけで結果は捨てる。 目的は早期検知 — 載らない head を審査に
 * 通すと、 モデルレビューもテストも走らせた末に取り込みで落ちる。 提出直後に分かれば
 * その 1 周ぶんの時間と費用を使わずに済む。
 *
 * 判定は取り込みと同じ手順 (`relandHeadOnBase`) を使う。 別の判定器を書くと、
 * 「提出時は通ったのに取り込みで落ちる」 ずれがそのまま運用の不信になる。
 *
 * 衝突以外の失敗 (worktree を作れない等) では衝突と報告しない。 判定できなかったことを
 * 提出の失敗にもしない — 審査へ進めれば取り込み時に改めて判定される。
 *
 * @implements SPEC-BASE-RELANDING
 */
export async function probeBaseMergeability({ mergeRepository, baseRef, headSha }) {
  assertSafeRef(baseRef, "base_ref");
  assertSafeSha(headSha, "head sha");
  const root = await mkdtemp(join(mergeRepository.rootPath, ".probe-"));
  const worktreePath = join(root, "probe");
  try {
    const baseSha = await git(mergeRepository.rootPath, [
      "rev-parse",
      "--verify",
      `refs/heads/${baseRef}`,
    ]);
    await relandHeadOnBase({
      repoPath: mergeRepository.rootPath,
      worktreePath,
      baseSha,
      headSha,
      baseRef,
    });
    return { status: "clean", baseSha, conflictedPaths: [] };
  } catch (error) {
    if (error instanceof MergeConflictError) {
      return {
        status: "conflict",
        conflictedPaths: error.conflictedPaths ?? [],
        reason: error.message,
      };
    }
    return {
      status: "unknown",
      conflictedPaths: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await cleanupWorktrees(mergeRepository.rootPath, {
      root,
      head: worktreePath,
      base: join(root, "unused"),
    });
  }
}
