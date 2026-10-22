/**
 * 審査の差分起点 (merge repository の base) を GitHub の base へ追いつかせる。
 *
 * merge repository の base は Revisor の所有物で、 登録元 checkout からは refresh しない
 * (`merge-repository.mjs` の注釈)。 進めるのは publication と GitHub reconciliation だけで、
 * 後者はこれまで publish 直前にしか走らなかった。 そのため別拠点の Revisor が GitHub へ
 * publish したコミットは、 この拠点で次にマージするまで merge repository に入らない。
 * その間に投入された審査は古い base を起点にし、 他所でマージ済みの変更まで PR の差分に
 * 含めてしまう (2026-10-20、 Concordia #41 の 560 行の変更が 35,374 行として審査に渡り、
 * Anatomia が heap 枯渇で落ちて「analysis unavailable」と区別がつかなかった)。
 *
 * ここでは GitHub 側の先行コミットを ff でだけ取り込む。 分岐していれば base は動かさず
 * (merge commit を作るのは publish 直前の reconcile の役目)、 GitHub に届かないときも
 * 審査を止めない — 追随はあくまで差分を正すための前処理で、 できなければ従来通り進む。
 */

import { reconcileBaseWithRemote } from "./base-reconcile.mjs";
import { serviceLog } from "./service-log.mjs";

/**
 * @param {{ repository: { repository: string, rootPath: string }, baseRef: string }} input
 *   `repository` は `prepareMergeRepository` が返した merge repository。
 * @returns {Promise<{ action: string }>} reconcile の action、 または追随できなかったときの
 *   "unavailable"。
 */
export async function refreshReviewBase({
  repository,
  baseRef,
  env = process.env,
  reconcile = reconcileBaseWithRemote,
  log = serviceLog,
}) {
  try {
    const result = await reconcile({ repository, baseRef, env, fastForwardOnly: true });
    if (result.action !== "none") {
      log("review_base_refreshed", {
        repository: repository.repository,
        baseRef,
        action: result.action,
        localSha: result.localSha,
        remoteSha: result.remoteSha,
      }, { level: result.action === "diverged" ? "warn" : "info" });
    }
    return result;
  } catch (error) {
    log("review_base_refresh_failed", {
      repository: repository.repository,
      baseRef,
      reason: error instanceof Error ? error.message : String(error),
    }, { level: "warn" });
    return { action: "unavailable" };
  }
}
