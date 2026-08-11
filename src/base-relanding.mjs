import { MergeConflictError } from "./errors.mjs";
import {
  assertSafeSha,
  git,
  gitWithoutLfs,
} from "./workspace.mjs";

// 提出元へ返す一覧と各表示名の上限。 衝突が広範、または path が極端に長いときに、
// 盤面・state・通知が 1 件の PR で埋まらないようにする。構造化された一覧は切り詰めない。
const MAX_REPORTED_PATHS = 20;
const MAX_REPORTED_PATH_LENGTH = 240;

/**
 * `git merge --squash --no-commit` が残した unmerged entry を読む。
 *
 * コンフリクト判定をエラーメッセージだけに頼らない。 `git()` のメッセージは stderr を
 * 優先するので、 Windows の autocrlf 警告のような無関係な stderr が 1 行でも出ると
 * "CONFLICT" が message から消え、 コンフリクトが「不明な失敗」に化ける (PR は Test OK
 * のまま残り、 スイープが 60 秒ごとに同じ失敗を繰り返す)。 index の unmerged entry を
 * 一次情報として見る。
 */
export async function conflictedPaths(worktreePath) {
  let output;
  try {
    output = await git(worktreePath, ["ls-files", "--unmerged", "-z"]);
  } catch {
    // index を読めないなら判定材料が無い。 コンフリクト扱いにはしない。
    return [];
  }
  const paths = [];
  const seen = new Set();
  for (const record of output.split("\0")) {
    if (!record) continue;
    const separator = record.indexOf("\t");
    if (separator === -1) continue;
    const path = record.slice(separator + 1);
    // 同じパスが stage 1/2/3 で最大 3 回出る。
    if (path && !seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

export function conflictMessage(baseRef, paths) {
  if (paths.length === 0) {
    return `The head conflicts with the current '${baseRef}'; Revisor does not resolve conflicts automatically.`;
  }
  const shown = paths.slice(0, MAX_REPORTED_PATHS);
  const remaining = paths.length - shown.length;
  return `The head conflicts with the current '${baseRef}' in ${paths.length} file(s): `
    + shown.map((path) => JSON.stringify(
      path.length > MAX_REPORTED_PATH_LENGTH
        ? `${path.slice(0, MAX_REPORTED_PATH_LENGTH - 3)}...`
        : path,
    )).join(", ")
    + (remaining > 0 ? `, and ${remaining} more` : "")
    + ". Resolve them and submit a new review; Revisor does not resolve conflicts automatically.";
}

/**
 * 現在の base の上へ、 その head の正味の変更だけを載せる (`review-diff-scope.md` 規則 3)。
 *
 * 手で回していた `git reset --hard <現在の base>` + `git merge --squash <head>` と等価な
 * 処理を、 Revisor 所有の merge repository の中だけで行う。 使い捨て worktree を base の
 * コミットに detach して作るので、 登録元 checkout はもちろん merge repository 自身の
 * ref・index・作業ツリーも動かさない。 提出元ブランチの履歴も書き換えない。
 *
 * 載せ替えは決定的な作業で人間の判断を要さないため、 セッションに rebase をやり直させ
 * ない。 返すのは衝突したときの一覧だけで、 自動解決はしない。
 *
 * 成功時、 `worktreePath` の index には base の上に載った結果が staged のまま残る
 * (`--no-commit`)。 コミットは呼び出し側 (マージ経路) が行う。
 */
export async function relandHeadOnBase({ repoPath, worktreePath, baseSha, headSha, baseRef }) {
  // Both values are later interpreted as Git revisions. They normally come
  // from Git itself, but this public boundary also receives persisted state;
  // reject option-like or revision-expression input before constructing argv.
  assertSafeSha(baseSha, "base_sha");
  assertSafeSha(headSha, "head_sha");
  await gitWithoutLfs(repoPath, ["worktree", "add", "--detach", worktreePath, baseSha]);
  try {
    // A squash merge always stages a single-parent result. Git rejects
    // `--no-ff` together with `--squash`, so do not add a fast-forward flag.
    await gitWithoutLfs(worktreePath, ["merge", "--squash", "--no-commit", headSha]);
  } catch (error) {
    const paths = await conflictedPaths(worktreePath);
    const message = error instanceof Error ? error.message : String(error);
    if (paths.length > 0 || /CONFLICT|Automatic merge failed/i.test(message)) {
      throw new MergeConflictError(conflictMessage(baseRef, paths), {
        cause: error,
        conflictedPaths: paths,
      });
    }
    throw error;
  }
  return { worktreePath, baseSha, headSha };
}
