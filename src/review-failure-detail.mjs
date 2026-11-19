/**
 * 審査が通らなかったときに、投稿元セッションへ「何が・どこで・なぜ」落ちたかを
 * 通知本文の中で読めるようにする行を組み立てる。
 *
 * 以前の通知は失敗理由を 300 文字で切った 1 行と「再実行するか、原因を確認して
 * ください」だけで、どの登録テストが落ちたのか・終了コード・出力はセッションに
 * 届かず、PR 詳細を開くか全スイートを手元で再実行しないと原因が分からなかった
 * (neco 2026-11-19「審査失敗の理由をセッションにちゃんと返して、詳細を説明すること」)。
 *
 * 出力は ci.mjs が保存した redact 済みの末尾 (test-output.mjs) だけを使い、生の
 * プロセス出力には触れない。通知 1 通の大きさを保つため、件数・行数・文字数に
 * 上限を置き、切った場合は必ず本文にそう書く。
 */

export const MAX_DETAILED_CHECKS = 5;
export const MAX_OUTPUT_LINES = 20;
export const MAX_OUTPUT_CHARS = 2000;
export const MAX_ERROR_CHARS = 2000;

const STATUS_LABEL = {
  failed: "失敗",
  error: "未実行 (実行エラー)",
};

function clip(text, maxChars) {
  const value = String(text);
  if (value.length <= maxChars) return { text: value, clipped: false };
  return { text: value.slice(0, maxChars), clipped: true };
}

/** 出力の末尾 (失敗のまとめは最後に出る) を行数・文字数の上限内で返す。 */
export function outputTail(output) {
  const raw = typeof output?.text === "string" ? output.text.trimEnd() : "";
  if (raw === "") return null;
  const lines = raw.split(/\r?\n/);
  let kept = lines.slice(-MAX_OUTPUT_LINES).join("\n");
  let cut = lines.length > MAX_OUTPUT_LINES || output.truncated === true;
  if (kept.length > MAX_OUTPUT_CHARS) {
    kept = kept.slice(kept.length - MAX_OUTPUT_CHARS);
    const firstBreak = kept.indexOf("\n");
    if (firstBreak >= 0) kept = kept.slice(firstBreak + 1);
    cut = true;
  }
  return { text: kept, cut };
}

function indent(text, prefix = "    ") {
  return text.split("\n").map((line) => `${prefix}${line}`);
}

function checkHeadline(check) {
  const parts = [STATUS_LABEL[check.status] ?? String(check.status)];
  if (typeof check.domain === "string" && check.domain) parts.push(`ドメイン ${check.domain}`);
  if (Number.isFinite(check.failed) && Number.isFinite(check.total)) {
    parts.push(`${check.failed}/${check.total} 件失敗`);
  }
  if (check.exitCode !== null && check.exitCode !== undefined) parts.push(`exit ${check.exitCode}`);
  if (check.runId) parts.push(`runId ${check.runId}`);
  return `- ${check.name ?? "(名前なし)"}: ${parts.join(" / ")}`;
}

/** 落ちた・実行できなかった登録チェックを、名前・理由・出力末尾つきで並べる。 */
export function failedCheckLines(ci) {
  const failing = (Array.isArray(ci) ? ci : [])
    .filter((check) => check && (check.status === "failed" || check.status === "error"));
  if (failing.length === 0) return [];
  const lines = [`失敗した登録チェック (${failing.length} 件):`];
  for (const check of failing.slice(0, MAX_DETAILED_CHECKS)) {
    lines.push(checkHeadline(check));
    if (check.reason) lines.push(`  理由: ${clip(check.reason, 500).text}`);
    const tail = outputTail(check.output);
    if (tail) {
      lines.push(tail.cut ? "  出力 (末尾のみ。全文は PR 詳細の審査レポート):" : "  出力:");
      lines.push(...indent(tail.text));
    } else if (check.status === "failed") {
      lines.push("  出力: 記録なし");
    }
  }
  if (failing.length > MAX_DETAILED_CHECKS) {
    lines.push(`- ほか ${failing.length - MAX_DETAILED_CHECKS} 件 (PR 詳細の審査レポートを参照)`);
  }
  return lines;
}

/** 審査そのものが完了しなかったときの理由。複数行を保ち、切ったら明記する。 */
export function reviewErrorLines(error) {
  if (error === null || error === undefined || String(error).trim() === "") {
    return ["理由: Revisor に失敗理由が記録されていません (審査 worker が理由を残さずに停止した可能性があります)。"];
  }
  const { text, clipped } = clip(String(error).trim(), MAX_ERROR_CHARS);
  const lines = text.split(/\r?\n/);
  const out = lines.length === 1 ? [`理由: ${lines[0]}`] : ["理由:", ...indent(text, "  ")];
  if (clipped) out.push(`  (理由は ${MAX_ERROR_CHARS} 文字で切りました。全文は PR 詳細の審査レポート)`);
  return out;
}

/** 失敗通知の最後に置く、次に何をすればよいかの案内。 */
export function failureNextStepLines({ hasFailedChecks }) {
  return hasFailedChecks
    ? ["次の手: 上の失敗したチェックの理由と出力から原因を直し、commit して同じ PR を再提出してください。"]
    : ["次の手: 理由がコードや設定の問題なら直して再提出してください。審査側の停止・中断 (worker 停止・Revisor 再起動など) なら、同じ head のまま再審査を依頼してください。"];
}
