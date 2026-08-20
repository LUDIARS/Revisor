/**
 * 認可済みのブランチ送出であることを push guard へ伝える環境変数。
 *
 * publication の `REVISOR_PUBLISHING` とは別に切る。 同じ旗を使い回すと、
 * ブランチ送出の認可がそのまま base 送出の認可になってしまう。
 *
 * 旗の名前だけを持つ独立モジュールにしてあるのは、 pre-push hook から毎回起動
 * される push guard に、 GitHub App / 設定復号までの import を背負わせないため。
 *
 * @implements spec/plan/branch-push-design.md
 */
export const BRANCH_PUSH_ENV_FLAG = "REVISOR_BRANCH_PUBLISHING";
