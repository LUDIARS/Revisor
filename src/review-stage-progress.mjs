/**
 * 審査段階の通過記録 (stage progress) の正本。
 *
 * 落ちる間隔がレビュー所要時間より短いあいだ、 完走時にまとめて書く方式では
 * 進捗が一切残らず、 再投入のたびにゼロからやり直しになる。 そこで各段階が
 * 終わった時点でフラグと **その段階を通したときの head SHA** を PR レコードへ
 * 書き、 再投入時は完了済み段階を再実行しない (`spec/feature/crash-recovery.md`)。
 *
 * ここが `intentReviewCompleted` の後継であり、 同じ意味の状態を 2 箇所に持たない:
 * モデルレビューの通過も `review` 段階のフラグとして 1 箇所に記録する。
 */

import { testsPassed } from "./ci.mjs";

// 進捗として記録する審査段階。 worker の実行ステージ名 (`review-work.mjs`) とは
// 分離する。 初期解析のような内部補助処理はここへ混ぜない。
export const REVIEW_STAGES = Object.freeze(["anatomia", "tests", "review", "security"]);

// 再検証で選択的にやり直せる決定的段階。 `leakage` は差分から即座に再計算できて
// worker コストも掛からないので進捗段階に数えず、 常にやり直す。
export const DETERMINISTIC_REVIEW_STAGES = Object.freeze(["anatomia", "tests", "security"]);

/**
 * Security evidence that can safely be reused by a later review.
 *
 * A prerequisite-blocked scan also has status `skipped`, but it is not a
 * completed security stage: once the prerequisite passes, the scan must run.
 * Likewise, settings-based and "covered by pre-merge" skips are reevaluated on
 * every review because their premise is external to the recorded review plan.
 */
export function securityStageCompleted(security) {
  return security?.status === "passed"
    || (security?.status === "skipped" && security.reason === "not required by the review plan");
}

function sameSha(left, right) {
  return typeof left === "string"
    && typeof right === "string"
    && left.length > 0
    && left.toLowerCase() === right.toLowerCase();
}

/**
 * PR レコードから進捗記録を読む。
 *
 * この変更より前に書かれたレコードには `reviewStages` が無い。 その場合だけ
 * 旧 `intentReviewCompleted` / `reviewedHeadSha` を `review` 段階の通過として
 * 読み替える。 書き戻しは新形式のみで、 二重管理にはしない。
 */
export function stageProgressRecord(pullRequest) {
  const stored = pullRequest?.reviewStages;
  if (stored && typeof stored === "object") return stored;
  if (pullRequest?.intentReviewCompleted === true && typeof pullRequest?.reviewedHeadSha === "string") {
    return { review: { completed: true, headSha: pullRequest.reviewedHeadSha, at: null } };
  }
  return {};
}

/**
 * 「モデルレビューを通したヘッド」。 完走した審査は `reviewedHeadSha` を残すが、
 * 途中で落ちた審査ではチェックポイントの段階記録しか残らない。 どちらの場合も
 * 1 つの入口から読む。
 */
export function reviewedHeadShaOf(pullRequest) {
  const progress = stageProgressRecord(pullRequest);
  const staged = progress?.review?.headSha;
  if (typeof staged === "string" && staged) return staged;
  const completed = pullRequest?.reviewedHeadSha;
  return typeof completed === "string" && completed ? completed : null;
}

export function withCompletedStage(progress, stage, headSha, at = null) {
  if (!REVIEW_STAGES.includes(stage)) {
    throw new Error(`Unknown review stage '${stage}'.`);
  }
  return {
    ...(progress && typeof progress === "object" ? progress : {}),
    [stage]: { completed: true, headSha: String(headSha), at },
  };
}

/**
 * 段階の成果が PR レコードに残っているか。
 *
 * フラグだけあって成果が無い段階を「通過済み」として飛ばすと、
 * `runPartialVerification` が前回結果を要求して落ちる。 フラグと成果は
 * 常に組で判定する。
 */
export function stagePayloadPresent(pullRequest, stage) {
  if (stage === "anatomia") {
    const anatomia = pullRequest?.anatomia;
    return Boolean(anatomia?.domain && anatomia?.quality && anatomia?.architecture);
  }
  if (stage === "tests") return Array.isArray(pullRequest?.ci);
  if (stage === "security") return securityStageCompleted(pullRequest?.security);
  // モデルレビューの成果は判定そのもの (通過した事実) で、追加の payload を要求しない。
  return true;
}

/**
 * 現在のヘッドに対して有効な通過済み段階。
 *
 * head SHA が一致しない通過は無効。 ただし base 載せ替えで SHA だけ動いた場合は
 * 呼び出し側が差分の指紋 (`diffPatchId`) で内容一致を判定し、
 * `contentUnchanged` で渡す。
 */
export function completedStagesForHead(pullRequest, { headSha, contentUnchanged = false } = {}) {
  const progress = stageProgressRecord(pullRequest);
  const completed = new Set();
  for (const stage of REVIEW_STAGES) {
    const entry = progress?.[stage];
    if (!entry || entry.completed !== true) continue;
    if (!contentUnchanged && !sameSha(entry.headSha, headSha)) continue;
    if (!stagePayloadPresent(pullRequest, stage)) continue;
    completed.add(stage);
  }
  return completed;
}

/**
 * 再投入時に持ち越す進捗。 再利用する段階だけを残し、 head SHA は新しいヘッドへ
 * 打ち直す (内容一致で引き継いだ場合に、 次の中断でまた無効化されないため)。
 */
export function retainedStageProgress(pullRequest, reusedStages, headSha) {
  const progress = stageProgressRecord(pullRequest);
  const retained = {};
  for (const stage of reusedStages ?? []) {
    const entry = progress?.[stage];
    if (!entry || entry.completed !== true) continue;
    retained[stage] = { completed: true, headSha: String(headSha), at: entry.at ?? null };
  }
  return Object.keys(retained).length > 0 ? retained : null;
}

/**
 * 再投入時に PR レコードへ残す段階成果。 `pendingReviewProjection()` は前回の
 * 判定を捨てるが、 再利用すると決めた段階の成果まで捨てると
 * `runPartialVerification` が前回結果を読めなくなる。
 */
export function retainedStageProjection(pullRequest, reusedStages) {
  const stages = new Set(reusedStages ?? []);
  return {
    ...(stages.has("anatomia") ? { anatomia: pullRequest?.anatomia ?? null } : {}),
    ...(stages.has("tests") ? { ci: pullRequest?.ci ?? [] } : {}),
    ...(stages.has("security") ? { security: pullRequest?.security ?? null } : {}),
    ...(stages.has("review")
      ? {
          reviewer: pullRequest?.reviewer ?? null,
          reviewPlan: pullRequest?.reviewPlan ?? null,
        }
      : {}),
  };
}

/**
 * 完走した job の結果から進捗を組み立てる。 完走時の書き込みは途中の
 * チェックポイントを置き換える正本であって、 追加の状態ではない。
 */
export function stageProgressFromResult(result, headSha, at = null) {
  const entry = { completed: true, headSha: String(headSha), at };
  const progress = {};
  if (result?.intentReviewCompleted === true) progress.review = entry;
  if (result?.analysis?.domain && result?.analysis?.quality && result?.analysis?.architecture) {
    progress.anatomia = entry;
  }
  if (testsPassed(result?.ci)) progress.tests = entry;
  if (securityStageCompleted(result?.security)) {
    progress.security = entry;
  }
  return Object.keys(progress).length > 0 ? progress : null;
}
