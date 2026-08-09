import { git } from "./workspace.mjs";

// 登録 checkout が読めない状態 (所有者の汚染、 移動、 削除、 .git の破損) は、 これまで
// マージ直前の clone まで表に出なかった。 起動時に全件を同じやり方で 1 回確かめる。
/** @implements SPEC-SERVICE-REGISTERED-CHECKOUT-ACCESS */
export async function inspectRepositoryAccess(repository, { runGit = git } = {}) {
  const record = {
    repository: repository?.repository ?? null,
    rootPath: repository?.rootPath ?? null,
  };
  if (!record.rootPath) {
    return { ...record, ok: false, reason: "root_path is not registered." };
  }
  try {
    const gitDir = await runGit(record.rootPath, ["rev-parse", "--absolute-git-dir"]);
    return { ...record, ok: true, gitDir };
  } catch (error) {
    return {
      ...record,
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/** @implements SPEC-SERVICE-REGISTERED-CHECKOUT-ACCESS */
export async function inspectRegisteredRepositories(repositories, { runGit = git } = {}) {
  return Promise.all(
    (repositories ?? []).map((repository) => inspectRepositoryAccess(repository, { runGit })),
  );
}

/** @implements SPEC-SERVICE-REGISTERED-CHECKOUT-ACCESS */
export function unreachableRepositories(results) {
  return (results ?? []).filter((result) => !result.ok);
}

// git の失敗は複数行で返る。 1 行に畳んで、 起動ログの 1 件 1 行を保つ。
/** @implements SPEC-SERVICE-REGISTERED-CHECKOUT-ACCESS */
export function formatRepositoryAccessFailure(result) {
  const reason = String(result?.reason ?? "unknown error").replace(/\s+/g, " ").trim();
  return `${result?.repository ?? "(unregistered)"} at ${result?.rootPath ?? "(no path)"}: ${reason}`;
}
