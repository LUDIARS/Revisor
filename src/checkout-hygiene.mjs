/**
 * Registered-checkout hygiene: restore the watched repository to its base ref
 * before a merge advances it.
 *
 * Revisor never switches branches itself, but sessions and manual test runs do
 * switch the registered rootPath to a head branch and leave edited files
 * behind. Both break the merge in `advanceLocalBranch`: a dirty base worktree
 * refuses the fast-forward, and a checkout left on another branch runs the
 * Test Workflow against the wrong code. Policy (2026-08-08):
 *
 *   - Sessions must not leave file debris in a Revisor-watched directory.
 *   - The watched checkout leaves the base ref only for the Test Workflow.
 *   - Before a merge, the checkout returns to the base ref and files with
 *     changes are stashed (never deleted — the stash keeps them recoverable).
 */

import { assertSafeRef, git } from "./workspace.mjs";

/**
 * Restore `rootPath` to `baseRef`. Uncommitted changes (tracked and untracked)
 * are stashed first so nothing a session left behind is lost, then the
 * checkout is switched back. Returns what was done so the caller can log it.
 */
export async function restoreBaseCheckout({ rootPath, baseRef, runGit = git }) {
  // `baseRef` is persisted PR input and is passed to `git checkout` without a
  // `refs/heads/` prefix. Validate it here so it cannot be parsed as an option
  // or as an arbitrary revision expression.
  assertSafeRef(baseRef, "base_ref");
  const report = { previousRef: null, stashed: false, switched: false };
  let currentRef;
  try {
    currentRef = await runGit(rootPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {
    // 空リポジトリ等で HEAD を読めないなら復元対象が無い。 マージ側の検証に任せる。
    return report;
  }
  report.previousRef = currentRef;

  // Untracked and ignored debris can both block a later checkout when the base
  // ref contains a file of the same name, so inspect and stash both.
  // Submodule-internal edits stay with their submodule (same boundary as
  // trackedChanges in workspace).
  const status = await runGit(rootPath, [
    "status",
    "--porcelain",
    "--ignored",
    "--ignore-submodules=dirty",
  ]);
  if (status) {
    await runGit(rootPath, [
      "stash",
      "push",
      "--all",
      "-m",
      `revisor-checkout-hygiene ${new Date().toISOString()} (${currentRef})`,
    ]);
    report.stashed = true;
  }

  // "HEAD" means detached; anything not the base ref goes back to it. The
  // Test Workflow switches the checkout deliberately, but a merge must never
  // run while the watched clone points at another branch.
  if (currentRef !== baseRef) {
    await runGit(rootPath, ["checkout", baseRef]);
    report.switched = true;
  }
  return report;
}
