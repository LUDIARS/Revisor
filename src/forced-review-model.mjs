import { readSettings } from "./config.mjs";
import { contract } from './contract-runtime.mjs'; /* augur-inject:import:cf427fe3 */
import augurContract_3b108e30 from '../contracts/forced-review-model-role.contract.mjs'; /* augur-inject:contract-predicate:72bcd062 */

// 審査モデルの強制上書き。通常は呼び出しの用途 (purpose) がモデルを決め、
// 審査判断は必ず strong 側になる (reviewer.mjs)。運用側で
// 「審査判断をこのモデルで行う」ときに、その選択を上書きする。
// 補助用途はこの設定を無視し、auxiliary 側のモデルを維持する。
//
// 値は argv の `--model` に載るので、自由入力ではなく既知のモデルだけを
// 受け付ける。同時に「そのモデルはどちらのレビュアー系列か」を持つ必要が
// あるため、単なる文字列検証ではなく登録表にしている。系列が分からないと
// `codex` に `--model opus` を渡すような取り合わせが作れてしまう。
// 強制できるのは**審査に使える役割**だけ。 sonnet / luna はレビュー向きでは
// ないと判断されており (neco 2026-08-21)、補助タスク専用に降りた。 ここへ残すと
// 「審査判断をこのモデルで行う」という指定でそれらを審査に戻せてしまう。
const FORCEABLE_REVIEW_MODELS = new Map([
  ["opus", "claude-opus"],
  ["sol", "codex-sol"],
]);

export const FORCEABLE_REVIEW_MODEL_ROLES = Object.freeze([...FORCEABLE_REVIEW_MODELS.keys()]);

// 以前の設定が保存した Codex Sol 系列の ID を、新しい役割値へ移行する。
const LEGACY_CODEX_SOL_ID = /^gpt-\d+(?:\.\d+)*-sol$/;

/** @implements SPEC-FORCED-REVIEW-MODEL */
export function normalizeForcedReviewModel(value) {
  if (value === "" || FORCEABLE_REVIEW_MODELS.has(value)) return value;
  if (typeof value === "string" && LEGACY_CODEX_SOL_ID.test(value)) return "sol";
  return null;
}
// @ts-expect-error augur-inject
normalizeForcedReviewModel = contract(normalizeForcedReviewModel, { ...augurContract_3b108e30, contractId: 'C-27', mode: 'observe', sample: 1, where: 'src/forced-review-model.mjs:26', rule: 'contract-wrap', id: '3b108e30' }); /* augur-inject:contract-wrap:3b108e30 */

/**
 * 空文字 (=強制なし) か、審査用の役割に変換できる値だけを受け付ける。
 *
 * @implements SPEC-FORCED-REVIEW-MODEL
 */
export function isForcedReviewModel(value) {
  return normalizeForcedReviewModel(value) !== null;
}

/**
 * 強制モデルが属するレビュアー系列。強制なし・未知の値では null。
 *
 * @implements SPEC-FORCED-REVIEW-MODEL
 */
export function forcedReviewerFor(model) {
  return FORCEABLE_REVIEW_MODELS.get(normalizeForcedReviewModel(model)) ?? null;
}

// 設定は審査ステージの子ワーカーからも読む。設定ファイルが無い / 壊れている
// ときに審査そのものを落とすと、強制上書きを使っていない環境まで巻き添えに
// なるので、読めなければ「強制なし」に倒す。強制が効いているかどうかは
// 設定画面と審査ログの reviewer 表示で確認できる。
/** @implements SPEC-FORCED-REVIEW-MODEL */
export function configuredForcedReviewModel(env = process.env, read = readSettings) {
  try {
    const value = read(env)?.forcedReviewModel;
    return normalizeForcedReviewModel(value) ?? "";
  } catch {
    return "";
  }
}
