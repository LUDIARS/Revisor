import { redactSecretLines } from "./leakage.mjs";

const MAX_LISTED_REASONS = 5;

// 見えない文字をソースへ直接書くと編集や lint で消えるので、コードポイントで持つ。
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

/**
 * PR タイトル・ブランチ名・失敗/取り下げ理由は投稿者が自由に決められる文字列で、
 * この channel はそのまま Discord へ配送される。資格情報をマスクし、
 * `@everyone` / `@here` / `<@id>` はゼロ幅スペースで無害化する。改行も畳んで、
 * 1 行 1 情報という体裁を差し込みで崩されないようにする。
 */
function plain(value) {
  return redactSecretLines(String(value ?? ""))
    .replace(/\s+/g, " ")
    .trim()
    .replace(/@(everyone|here)/gi, `@${ZERO_WIDTH_SPACE}$1`)
    .replace(/<@/g, `<${ZERO_WIDTH_SPACE}@`);
}

function pullRequestLabel(pullRequest) {
  return `${plain(pullRequest.repository)}#${plain(pullRequest.number)}`;
}

function titleLine(pullRequest) {
  const title = plain(pullRequest.title);
  return title ? `「${title.slice(0, 200)}」` : null;
}

// 失敗理由には worker の例外文がそのまま入る (`git ... failed: <stderr>`、spawn の
// ENOENT など) ため、ワークステーションの絶対パス = ホームディレクトリ名が混ざる。
// この channel は Discord へ出るので、ディレクトリ部分を落として末尾の名前だけ残す。
// ドライブ文字の直前が単語文字でないこと / POSIX の先頭 `/` が区切り直後であることを
// 要求して、`http://host/a/b` のような URL と `src/foo.mjs` のような相対パスは残す。
const ABSOLUTE_PATH =
  /(?:(?<![A-Za-z0-9])[A-Za-z]:[\\/]|(?<=^|[\s"'(=])\/)(?:[^\s"'(),;]*[\\/])+([^\s"'(),;]*)/g;

const PRIVATE_ENDPOINT =
  /\bhttps?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|\[::1\]|[^\s/:]+\.local)(?::\d+)?(?=\/|\s|$)(?:\/[^\s]*)?/gi;

function withoutLocalPaths(value) {
  return String(value ?? "").replace(ABSOLUTE_PATH, (_match, tail) => `…/${tail}`);
}

function reasonText(value) {
  const withoutPrivateEndpoints = String(value ?? "")
    .replace(PRIVATE_ENDPOINT, "[redacted: private endpoint]");
  return plain(withoutLocalPaths(withoutPrivateEndpoints));
}

function summarizeReasons(pullRequest) {
  const reasons = pullRequest.checkStatus === "failed" && pullRequest.error
    ? [reasonText(pullRequest.error)]
    : (pullRequest.reasons ?? []).map(reasonText);
  const listed = reasons.slice(0, MAX_LISTED_REASONS)
    .map((reason) => `- ${reason.slice(0, 300)}`);
  if (reasons.length > MAX_LISTED_REASONS) {
    listed.push(`- ほか ${reasons.length - MAX_LISTED_REASONS} 件`);
  }
  return listed;
}

/**
 * Discord の報告 channel に出す local PR lifecycle の短い状態通知。
 * 差分・テスト出力・leakage 値は含めず、state store の公開メタデータだけを使う。
 */
export function pullRequestLifecycleMessage(event, pullRequest) {
  const label = pullRequestLabel(pullRequest);
  const title = titleLine(pullRequest);
  const lines = [];
  if (event === "created") {
    lines.push(`🆕 Revisor PR 発行: ${label}`);
    if (title) lines.push(title);
    lines.push(`${plain(pullRequest.headRef)} → ${plain(pullRequest.baseRef)}`);
    lines.push("レビューを受け付けました。");
  } else if (event === "review_passed") {
    lines.push(`✅ Revisor 審査通過: ${label}`);
    if (title) lines.push(title);
    lines.push("Open / Test OK です。");
  } else if (event === "review_queued") {
    lines.push(`🔁 Revisor 再審査: ${label}`);
    if (title) lines.push(title);
    lines.push("レビューを再キューしました。");
  } else if (event === "review_failed") {
    lines.push(`❌ Revisor 審査失敗: ${label}`);
    if (title) lines.push(title);
    const reasons = summarizeReasons(pullRequest);
    if (reasons.length > 0) {
      lines.push("理由:");
      lines.push(...reasons);
    }
  } else if (event === "merged") {
    lines.push(`🟣 Revisor PR マージ: ${label}`);
    if (title) lines.push(title);
    if (pullRequest.mergeCommitSha) {
      lines.push(`マージコミット: ${plain(pullRequest.mergeCommitSha).slice(0, 12)}`);
    }
    if (pullRequest.releaseTag) lines.push(`リリース: ${plain(pullRequest.releaseTag)}`);
    if (pullRequest.releaseUrl) lines.push(plain(pullRequest.releaseUrl));
  } else if (event === "closed") {
    // 取り下げは「直せば通る」状態と見分けが付かないまま board から消える。 誰かが待って
    // いる可能性があるので、消えた事実と理由を必ず出す。
    lines.push(`🗑️ Revisor PR 取り下げ: ${label}`);
    if (title) lines.push(title);
    lines.push(`${plain(pullRequest.headRef)} → ${plain(pullRequest.baseRef)}`);
    const reason = reasonText(pullRequest.closeReason);
    lines.push(reason ? `理由: ${reason.slice(0, 300)}` : "理由の記録はありません。");
    lines.push("マージされていません。ブランチは残っています。");
  } else if (event === "bypass_merged") {
    // 審査を通さずに入った変更は、通知の時点で通常のマージと区別できなければ、
    // 後追いレビューの起点を人間が見失う。
    lines.push(`⚠️ Revisor バイパスマージ: ${label}`);
    if (title) lines.push(title);
    if (pullRequest.mergeCommitSha) {
      lines.push(`マージコミット: ${plain(pullRequest.mergeCommitSha).slice(0, 12)}`);
    }
    if (pullRequest.bypassMerge?.reason) {
      lines.push(`理由: ${plain(pullRequest.bypassMerge.reason)}`);
    }
    lines.push("審査を通していません。復旧後に後追いレビューが必要です。");
  } else {
    throw new TypeError(`Unknown PR lifecycle event '${event}'.`);
  }
  return lines.join("\n");
}

export function pullRequestLifecycleTone(event) {
  if (event === "review_passed") return "ok";
  if (event === "review_failed") return "bad";
  if (event === "merged") return "merged";
  if (event === "bypass_merged") return "warn";
  if (event === "review_queued") return "warn";
  // 取り下げは失敗ではないが、 マージされずに終わった終局なので idle とは区別する。
  if (event === "closed") return "warn";
  return "idle";
}

export async function notifyPullRequestLifecycle({
  event,
  pullRequest,
  baseUrl,
  notify,
}) {
  if (!pullRequest?.sessionId || !baseUrl) return false;
  return notify({
    baseUrl,
    sessionId: pullRequest.sessionId,
    channel: "報告",
    authorLabel: "Revisor",
    text: pullRequestLifecycleMessage(event, pullRequest),
  });
}
