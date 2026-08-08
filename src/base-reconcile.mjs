/**
 * GitHub base branch のローカル取り込み (reconcile)。
 *
 * ローカル base branch が正本だが、別拠点からの publish や GitHub 上の直接操作で
 * GitHub 側だけが進むことがある。その状態で publish すると
 * "GitHub '<base>' moved independently" で止まり、これまでは毎回人間が手で
 * 取り込んでいた (頻発)。ここは GitHub 側の先行コミットを**取り込む方向のみ**の
 * 自動修復: fast-forward できるなら ff、分岐していればクリーンな merge commit を
 * 作って base を前進させる。コンフリクトだけを人間に残す。force-push や
 * ローカル履歴の書き換えは一切しない (ローカル正本の原則は維持)。
 */

import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGitHubAppCredentials } from "./config.mjs";
import { GitHubAppClient } from "./github-app.mjs";
import { githubRemoteUrl, runAuthenticatedGit } from "./authenticated-git.mjs";
import { RevisorError } from "./errors.mjs";
import { advanceLocalBranch, cleanupWorktrees, git, NO_LFS_FILTER_ARGS } from "./workspace.mjs";

async function isAncestor(runGit, rootPath, ancestor, descendant) {
  try {
    await runGit(rootPath, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/**
 * GitHub の base branch をローカル base branch へ取り込む。
 * 返り値の action: "none" (取り込み不要) / "fast_forward" / "merge"。
 */
export async function reconcileBaseWithRemote({
  repository,
  baseRef,
  env = process.env,
  runGit = git,
  runRemoteGit = runAuthenticatedGit,
  createClient = (credentials) => new GitHubAppClient(credentials),
}) {
  const rootPath = repository.rootPath;
  const client = createClient(readGitHubAppCredentials(env));
  const token = await client.installationToken(repository.repository);
  // FETCH_HEAD is shared by every Git operation in this repository. Keep the
  // fetched object in a per-attempt private ref so another job's fetch cannot
  // cause this reconciliation to merge the wrong remote tip.
  const fetchedRef = `refs/revisor/reconcile/${randomUUID()}`;
  let remoteSha;
  try {
    await runRemoteGit({
      cwd: rootPath,
      args: [
        "fetch",
        githubRemoteUrl(repository.repository),
        `+refs/heads/${baseRef}:${fetchedRef}`,
      ],
      token,
      env,
    });
    remoteSha = await runGit(rootPath, ["rev-parse", "--verify", fetchedRef]);
  } finally {
    try {
      await runGit(rootPath, ["update-ref", "-d", fetchedRef]);
    } catch {
      // A failed fetch may not have created the private ref; cleanup must not
      // conceal that failure.
    }
  }
  const localSha = await runGit(rootPath, ["rev-parse", "--verify", `refs/heads/${baseRef}`]);

  if (remoteSha.toLowerCase() === localSha.toLowerCase()
    || await isAncestor(runGit, rootPath, remoteSha, localSha)) {
    return { action: "none", localSha, remoteSha };
  }
  if (await isAncestor(runGit, rootPath, localSha, remoteSha)) {
    await advanceLocalBranch(rootPath, baseRef, localSha, remoteSha);
    return { action: "fast_forward", localSha: remoteSha, remoteSha };
  }

  // 双方に固有コミットがある。使い捨て worktree で merge commit を作り、クリーンに
  // 解決できたときだけ base を前進させる (監視 checkout は触らない)。
  const root = await mkdtemp(join(tmpdir(), "revisor-base-reconcile-"));
  const worktrees = { root, head: join(root, "reconcile"), base: join(root, "unused") };
  try {
    await runGit(rootPath, [
      ...NO_LFS_FILTER_ARGS,
      "worktree", "add", "--detach", worktrees.head, localSha,
    ]);
    try {
      await runGit(worktrees.head, [
        ...NO_LFS_FILTER_ARGS,
        "-c",
        "user.name=LUDIARS Revisor",
        "-c",
        "user.email=revisor@localhost",
        "merge",
        "--no-ff",
        remoteSha,
        "-m",
        `Reconcile GitHub '${baseRef}' into local '${baseRef}'`,
      ]);
    } catch (error) {
      throw new RevisorError(
        `GitHub '${baseRef}' and local '${baseRef}' conflict; reconcile them manually before publishing.`,
        { cause: error },
      );
    }
    const mergeSha = await runGit(worktrees.head, ["rev-parse", "HEAD"]);
    await advanceLocalBranch(rootPath, baseRef, localSha, mergeSha);
    return { action: "merge", localSha: mergeSha, remoteSha };
  } finally {
    await cleanupWorktrees(rootPath, worktrees);
  }
}
