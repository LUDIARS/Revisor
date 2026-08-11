/**
 * レビュー完了を、その PR を投げてきた Concordia セッションへ知らせる。
 *
 * Revisor はローカル駆動でレビューに数分〜十数分かかるため、投稿側が結果を
 * ポーリングし続けなければならなかった。投稿時に受け取った session_id 宛へ
 * Concordia の inject で 1 回だけ結果を送り、セッションが待たずに次へ進めるようにする。
 *
 * 送るのは終局状態だけ (test_ok / action_required / failed)。途中経過は送らない
 * (Cc 通知は 1 レビュー 1 通の方針、neco 2026-07-30)。
 */

const MAX_LISTED_REASONS = 5;

function summarizeList(items, max = MAX_LISTED_REASONS) {
  const listed = items.slice(0, max).map((item) => `- ${item}`);
  if (items.length > max) listed.push(`- ほか ${items.length - max} 件`);
  return listed;
}

/**
 * 通知本文。verdict は state store の PR レコード形状
 * ({checkStatus, reasons, advisories, error, ...})。
 */
export function reviewCompletionMessage(pullRequest) {
  const label = `${pullRequest.repository}#${pullRequest.number}`;
  const lines = [];
  if (pullRequest.checkStatus === "test_ok") {
    // 通知は自動マージの後に送るので、マージ済みかどうかで伝える内容が変わる。
    // TestWorkflow フォーラムに載るのは open のままの PR だけ (state store は
    // status === "open" で絞る) なので、マージ済みの PR をそこへ誘導しない。
    if (pullRequest.status === "merged") {
      lines.push(`✅ Revisor レビュー完了: ${label} は Test OK で自動マージされました。`);
      if (pullRequest.mergeCommitSha) {
        lines.push(`マージコミット: ${String(pullRequest.mergeCommitSha).slice(0, 12)}`);
      }
      if (pullRequest.releaseTag) lines.push(`リリース: ${pullRequest.releaseTag}`);
      if (pullRequest.releaseUrl) lines.push(String(pullRequest.releaseUrl));
    } else {
      lines.push(`✅ Revisor レビュー完了: ${label} は Open / Test OK です (マージ可能)。`);
      // Test OK のまま open な PR は Concordia の TestWorkflow フォーラムに載る。
      lines.push("Discord の TestWorkflow フォーラムには「テスト開始OK」「マージOK」と投稿されます。動作確認はそのスレッドで記録してください。");
    }
  } else if (pullRequest.checkStatus === "failed") {
    lines.push(`⚠️ Revisor レビュー失敗: ${label} は審査を完了できませんでした。`);
    if (pullRequest.error) lines.push(`理由: ${String(pullRequest.error).slice(0, 300)}`);
    lines.push("再実行するか、原因を確認してください。");
  } else {
    lines.push(`🔴 Revisor レビュー完了: ${label} はマージできません。`);
    const reasons = pullRequest.reasons ?? [];
    if (reasons.length > 0) {
      lines.push("ブロック理由:");
      lines.push(...summarizeList(reasons));
    }
  }
  const advisories = pullRequest.advisories ?? [];
  if (advisories.length > 0) {
    lines.push("所見 (非ブロック):");
    lines.push(...summarizeList(advisories));
  }
  if (pullRequest.humanQuestion) {
    lines.push(String(pullRequest.humanQuestion));
  }
  return lines.join("\n");
}

/**
 * 完了通知を送る。session_id を持たない PR (CLI/スクリプト投稿) は送らない。
 * 通知は best-effort で、失敗しても審査結果は変えない。
 */
export async function notifyReviewCompletion({ pullRequest, baseUrl, notify }) {
  if (!pullRequest?.sessionId || !baseUrl) return false;
  return notify({
    baseUrl,
    sessionId: pullRequest.sessionId,
    text: reviewCompletionMessage(pullRequest),
  });
}
