import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { cleanupWorktrees, prepareLocalWorktrees } from "../src/workspace.mjs";

function git(repoPath, ...args) {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function repositoryFixture() {
  const directory = mkdtempSync(join(tmpdir(), "revisor-workspace-"));
  const repoPath = join(directory, "Product");
  const init = spawnSync("git", ["init", repoPath], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (init.status !== 0) throw new Error(init.stderr || init.stdout);
  git(repoPath, "checkout", "-b", "main");
  git(repoPath, "config", "user.name", "Test");
  git(repoPath, "config", "user.email", "test@example.invalid");
  writeFileSync(join(repoPath, "product.txt"), "base\n", "utf8");
  git(repoPath, "add", "product.txt");
  git(repoPath, "commit", "-m", "base");
  git(repoPath, "checkout", "-b", "feat/local");
  writeFileSync(join(repoPath, "product.txt"), "base\nfeature\n", "utf8");
  git(repoPath, "add", "product.txt");
  git(repoPath, "commit", "-m", "feature");
  git(repoPath, "checkout", "main");
  return {
    directory,
    repoPath,
    headSha: git(repoPath, "rev-parse", "refs/heads/feat/local"),
  };
}

function request(fixture) {
  return { headRef: "feat/local", baseRef: "main", headSha: fixture.headSha };
}

test("cleanup removes both disposable worktrees and the temp root", async () => {
  const fixture = repositoryFixture();
  try {
    const worktrees = await prepareLocalWorktrees(fixture.repoPath, request(fixture));
    assert.equal(existsSync(worktrees.head), true);
    assert.equal(existsSync(worktrees.base), true);

    await cleanupWorktrees(fixture.repoPath, worktrees);

    assert.equal(existsSync(worktrees.root), false);
    const remaining = git(fixture.repoPath, "worktree", "list", "--porcelain")
      .split(/\r?\n\r?\n/)
      .filter(Boolean);
    assert.equal(remaining.length, 1);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

// A temp directory the filesystem refuses to delete (Windows EBUSY/EPERM while an
// on-access scanner or an exiting child still holds a handle) must not turn an
// otherwise complete review into a failed one.
test("cleanup survives a temp root that cannot be removed", async () => {
  const fixture = repositoryFixture();
  let worktrees = null;
  try {
    worktrees = await prepareLocalWorktrees(fixture.repoPath, request(fixture));
    let attempted = null;

    await cleanupWorktrees(fixture.repoPath, worktrees, {
      removeRoot: (root) => {
        attempted = root;
        return Promise.reject(Object.assign(new Error("EBUSY"), { code: "EBUSY" }));
      },
    });

    assert.equal(attempted, worktrees.root);
    // The worktree registrations are still released; only the directory lingers.
    const remaining = git(fixture.repoPath, "worktree", "list", "--porcelain")
      .split(/\r?\n\r?\n/)
      .filter(Boolean);
    assert.equal(remaining.length, 1);
  } finally {
    // The stub kept the real deletion from running, so drop the root here.
    if (worktrees) rmSync(worktrees.root, { recursive: true, force: true });
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
