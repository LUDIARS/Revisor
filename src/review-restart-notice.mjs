/**
 * 再審査の開始を、その PR を投げてきた Concordia セッションへ知らせる。
 *
 * 完了通知 (`review-completion-notice.mjs`) は 1 レビュー 1 通の終局だけを送る。 ところが
 * 再審査は人手の retry だけでなく、 Revisor 再起動後の復旧・審査後の内容変化・高スコアの
 * 自動修正からも始まり、 提出したセッションからは「Test OK だったはずの PR が審査中に
 * 戻った」理由が見えなかった。 再審査の開始時に理由つきで 1 通送る (neco 2026-10-03)。
 *
 * @implements SPEC-REVIEW-RESTART-NOTICE
 */

export const REVIEW_RESTART_REASONS = Object.freeze({
  MANUAL: "manual",
  INTERRUPTED: "interrupted",
  STALE_CONTENT: "stale_content",
  RISK_REASSESSMENT: "risk_reassessment",
});

const REASON_TEXT = {
  [REVIEW_RESTART_REASONS.MANUAL]: "再審査の依頼を受けました",
  [REVIEW_RESTART_REASONS.INTERRUPTED]: "Revisor の再起動で中断された審査をやり直します",
  [REVIEW_RESTART_REASONS.STALE_CONTENT]: "審査後に差分の内容が変わったため、新しい内容で審査し直します",
  [REVIEW_RESTART_REASONS.RISK_REASSESSMENT]: "マージリスクが高いため、自動修正の後に全体を審査し直します",
};

/** 通知本文。 verdict ではなく、 何が・なぜ審査中へ戻ったかだけを伝える。 */
export function reviewRestartMessage(pullRequest, reason) {
  const label = `${pullRequest.repository}#${pullRequest.number}`;
  const lane = pullRequest.reviewLane === "fast" ? " (ファストレーン)" : "";
  return [
    `🔁 Revisor 再審査開始: ${label}${lane}`,
    `理由: ${REASON_TEXT[reason] ?? String(reason)}`,
    "結果は審査完了時にあらためて通知します。",
  ].join("\n");
}

/**
 * 開始通知を送る。 session_id を持たない PR (CLI/スクリプト投稿) は送らない。
 * 通知は best-effort で、 失敗しても再審査の受付は変えない。
 */
export async function notifyReviewRestart({ pullRequest, reason, baseUrl, notify }) {
  if (!pullRequest?.sessionId || !baseUrl) return false;
  return notify({
    baseUrl,
    sessionId: pullRequest.sessionId,
    text: reviewRestartMessage(pullRequest, reason),
  });
}
