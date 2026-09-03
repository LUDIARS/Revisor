import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

const TEMPORARY_ROOT = resolve(tmpdir());

function resolveFixturePath(directory) {
  if (typeof directory !== "string" || directory.length === 0) {
    throw new TypeError("Fixture cleanup requires a non-empty directory path.");
  }

  const target = resolve(directory);
  const relativeTarget = relative(TEMPORARY_ROOT, target);
  const escapesTemporaryRoot = relativeTarget === ".."
    || relativeTarget.startsWith(`..${sep}`)
    || isAbsolute(relativeTarget);
  if (!relativeTarget || escapesTemporaryRoot) {
    throw new RangeError("Fixture cleanup is restricted to children of the OS temporary directory.");
  }
  return target;
}

/**
 * テスト用の一時ディレクトリを消す。 消せなくてもテストは失敗させない。
 *
 * store は SQLite ハンドルをプロセス終了まで開いたまま持つ (close() を公開していない)
 * ので、 Windows では作業ディレクトリの削除が EPERM で必ず失敗する。 これを finally で
 * そのまま投げると、 try の中で起きた本来の AssertionError を上書きしてしまい、
 * 「assertion が通ったのかどうか分からない」状態になっていた — 実際、Windows では
 * 全テストが後始末のエラーで赤くなり、回帰の有無を判定できなかった。
 *
 * 後始末は検証対象ではないので、 失敗は握るが黙らせない。削除先は OS の一時領域配下に
 * 限定し、診断にはローカルのユーザー名やディレクトリ構成を含む絶対パスを出さない。
 */
export function removeFixture(directory) {
  const target = resolveFixturePath(directory);
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch (error) {
    const code = typeof error?.code === "string" ? error.code : "UNKNOWN";
    process.stderr.write(
      `fixture cleanup left ${JSON.stringify(basename(target))} behind: ${code}\n`,
    );
  }
}
