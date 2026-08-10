import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  advanceLocalBranch,
  assertSafeRef,
  git,
  isAncestor,
} from "./workspace.mjs";

/**
 * マージ後に、登録元 checkout の base ブランチを隔離マージ結果へ追随させる。
 *
 * Revisor は隔離 checkout (merge repository) でマージして GitHub へ push するため、
 * **登録元フォルダの main は誰も動かさない**。次に同じリポで PR を出すと必ず
 * 「head conflicts with the current 'main'」になり、毎回手で追随することになる
 * (2026-08-10 に Revisor / Excubitor / Concordia の 3 リポで発生)。
 *
 * ただし登録元の base が先行していることがある。Revisor が止まっている間に checkout へ
 * 直接当てられたコミットが載っている場合で、2026-08-09 の Concordia (`merge/cc-batch-main`)
 * がそれにあたる。この状態では fast-forward が成立せず、成立させようとすれば先行分を捨てる
 * ことになる。追随できるかどうかは Revisor には判断できないので、手を引いて人へ渡す。
 *
 * したがってこの同期は **fast-forward で確実に安全なときだけ**行い、少しでも判断が要る
 * 状況では何もしない。失敗も含め、しなかったことは理由付きで呼び出し側へ返す
 * (マージ自体は既に成立しているので、ここで例外を投げて巻き戻してはならない)。
 */
export async function syncSourceCheckout({
  sourceRootPath,
  mergeRootPath,
  baseRef,
  run = git,
}) {
  if (!sourceRootPath || !mergeRootPath || !baseRef) {
    return { synced: false, reason: "sync inputs are incomplete" };
  }
  if (!isAbsolute(sourceRootPath) || !isAbsolute(mergeRootPath)) {
    return { synced: false, reason: "checkout paths must be absolute" };
  }
  // 同一フォルダなら既にマージ結果そのもの。
  if (samePath(sourceRootPath, mergeRootPath)) {
    return { synced: false, reason: "the source checkout is the merge checkout" };
  }
  try {
    assertSafeRef(baseRef, "base branch");
    const before = await run(sourceRootPath, ["rev-parse", "--verify", `refs/heads/${baseRef}`]);
    // FETCH_HEAD is shared by all Git operations in a checkout. Keep this fetch
    // in a private ref so another lifecycle operation cannot advance the wrong tip.
    const fetchedRef = `refs/revisor/source-checkout-sync/${randomUUID()}`;
    try {
      // The merge repository is local, and this refspec can only advance our
      // private ref. The explicit option terminator prevents a path from being
      // interpreted as a Git option.
      await run(sourceRootPath, [
        "fetch",
        "--no-tags",
        "--",
        mergeRootPath,
        `refs/heads/${baseRef}:${fetchedRef}`,
      ]);
      const target = await run(sourceRootPath, ["rev-parse", "--verify", fetchedRef]);
      if (before.toLowerCase() === target.toLowerCase()) {
        return { synced: false, reason: "already up to date" };
      }
      // 登録元が先行しているなら ff にならない。意図的な別系統運用を壊さないため触らない。
      const isBehind = await isAncestor(sourceRootPath, before, target, { run });
      if (!isBehind) {
        return {
          synced: false,
          reason: `${baseRef} has local commits that the merge result does not contain`,
        };
      }
      // This checks every worktree that has the branch checked out and only
      // fast-forwards a clean one; otherwise it performs a guarded ref update.
      await advanceLocalBranch(sourceRootPath, baseRef, before, target, { run });
      return { synced: true, from: before, to: target };
    } finally {
      try {
        await run(sourceRootPath, ["update-ref", "-d", fetchedRef]);
      } catch {
        // A failed fetch may not have created the private ref.
      }
    }
  } catch (error) {
    return { synced: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function samePath(left, right) {
  const normalize = (value) => String(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  return normalize(left) === normalize(right);
}
