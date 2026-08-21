import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { RevisorError } from "./errors.mjs";

// 審査・マージ・走査が使う使い捨て作業領域を、どのドライブに置くかを一箇所で決める。
//
// 既定は OS の一時領域 (Windows なら %TEMP% = C:)。そこは OS とアプリが共有する
// 場所で、Revisor は 1 審査ごとに登録リポジトリの detached worktree を 2 本作り、
// その上で登録テストがビルド成果物を吐く。Rust や C++ のワークスペースだと
// 1 本で数 GB になり、システムドライブの空きを審査の回数だけ削っていく。空きが
// 尽きたときの壊れ方は「ディスクが足りない」とは出ず、proc-macro が作れず
// import resolution が詰まる、リンクすべき rlib が見つからない、といった
// コンパイルエラーとして出る。差分は健全なのに登録テストだけが落ちるので、
// 原因がソースにあるように見えてしまう。
//
// 設定で別の親ディレクトリを与えられれば、空きのあるドライブへ丸ごと逃がせる。
// 置き場所を決めるのはこの境界の責務で、作業領域を使う側 (worktree の生成、
// squash マージ、base の突合、セキュリティ走査) は親をどこにするか知らない。

/**
 * 設定値から使い捨て作業領域の親ディレクトリを決める。空なら OS の一時領域。
 *
 * @implements SPEC-REVIEW-SCRATCH-ROOT
 */
export function resolveScratchRoot(settings = {}) {
  const configured = typeof settings.reviewScratchRoot === "string"
    ? settings.reviewScratchRoot.trim()
    : "";
  if (!configured) return tmpdir();
  if (!isAbsolute(configured)) {
    // 相対パスは解決の基点が呼び出し側の cwd に依存する。審査は使い捨て
    // worktree を cwd にして走るので、同じ設定が実行のたびに別の場所を指す。
    throw new RevisorError(
      "Review scratch root must be an absolute path.",
    );
  }
  return configured;
}

/**
 * 使い捨て作業領域を 1 つ作って返す。親が未作成でも作る — 設定した時点では
 * まだ存在しないディレクトリを指していることがあり、そこで毎回落ちると
 * 設定できたのに動かない状態になる。
 *
 * @implements SPEC-REVIEW-SCRATCH-ROOT
 */
export async function makeScratchDir(prefix, settings = {}) {
  const root = resolveScratchRoot(settings);
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, prefix));
}
