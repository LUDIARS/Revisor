import { readSettings } from "./config.mjs";

// 審査モデルの強制上書き。通常は呼び出しの用途 (purpose) がモデルを決め、
// 審査判断は必ず strong 側になる (reviewer.mjs)。運用側で
// 「しばらく全部このモデルで見たい」ときに、その選択ごと踏み潰す。
//
// 値は argv の `--model` に載るので、自由入力ではなく既知のモデルだけを
// 受け付ける。同時に「そのモデルはどちらのレビュアー系列か」を持つ必要が
// あるため、単なる文字列検証ではなく登録表にしている。系列が分からないと
// `codex` に `--model opus` を渡すような取り合わせが作れてしまう。
// 強制できるのは**審査に使えるモデル**だけ。 sonnet / gpt-5.6-terra はレビュー向きでは
// ないと判断されており (neco 2026-08-21)、補助タスク専用に降りた。 ここへ残すと
// 「全レビューをこのモデルで見る」という指定でそれらを審査に戻せてしまう。
const FORCEABLE_REVIEW_MODELS = new Map([
  ["opus", "claude-opus"],
  ["gpt-5.6-sol", "codex-sol"],
]);

export const FORCEABLE_REVIEW_MODEL_IDS = Object.freeze([...FORCEABLE_REVIEW_MODELS.keys()]);

/**
 * 空文字 (=強制なし) か、登録済みモデル id だけを受け付ける。
 *
 * @implements SPEC-FORCED-REVIEW-MODEL
 */
export function isForcedReviewModel(value) {
  return value === "" || FORCEABLE_REVIEW_MODELS.has(value);
}

/**
 * 強制モデルが属するレビュアー系列。強制なし・未知の値では null。
 *
 * @implements SPEC-FORCED-REVIEW-MODEL
 */
export function forcedReviewerFor(model) {
  if (typeof model !== "string" || model === "") return null;
  return FORCEABLE_REVIEW_MODELS.get(model) ?? null;
}

// 設定は審査ステージの子ワーカーからも読む。設定ファイルが無い / 壊れている
// ときに審査そのものを落とすと、強制上書きを使っていない環境まで巻き添えに
// なるので、読めなければ「強制なし」に倒す。強制が効いているかどうかは
// 設定画面と審査ログの reviewer 表示で確認できる。
/** @implements SPEC-FORCED-REVIEW-MODEL */
export function configuredForcedReviewModel(env = process.env, read = readSettings) {
  try {
    const value = read(env)?.forcedReviewModel;
    return isForcedReviewModel(value) ? value : "";
  } catch {
    return "";
  }
}
