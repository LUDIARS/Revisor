import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { conflictMessage, relandHeadOnBase } from "../src/base-relanding.mjs";
import { MergeConflictError } from "../src/errors.mjs";
import { cleanupWorktrees } from "../src/workspace.mjs";

function git(repoPath, ...args) {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

/**
 * 他 PR が 1 本マージされて base が進んだ状態を作る。 head はその前の base から
 * 分岐しており、 そのままでは現在の base の上に載っていない。
 */
function relandingFixture({ conflicting }) {
  const directory = mkdtempSync(join(tmpdir(), "revisor-relanding-"));
  const repoPath = join(directory, "Product");
  const init = spawnSync("git", ["init", repoPath], { encoding: "utf8", windowsHide: true });
  if (init.status !== 0) throw new Error(init.stderr || init.stdout);
  git(repoPath, "checkout", "-b", "main");
  git(repoPath, "config", "user.name", "Test");
  git(repoPath, "config", "user.email", "test@example.invalid");
  writeFileSync(join(repoPath, "shared.txt"), "one\ntwo\nthree\n", "utf8");
  git(repoPath, "add", "shared.txt");
  git(repoPath, "commit", "-m", "base");

  git(repoPath, "checkout", "-b", "feat/local");
  writeFileSync(
    join(repoPath, conflicting ? "shared.txt" : "mine.txt"),
    conflicting ? "one\nmine\nthree\n" : "mine\n",
    "utf8",
  );
  git(repoPath, "add", "--all");
  git(repoPath, "commit", "-m", "this pull request");
  const headSha = git(repoPath, "rev-parse", "HEAD");

  // 他 PR のマージ。 base だけが進む。
  git(repoPath, "checkout", "main");
  writeFileSync(
    join(repoPath, conflicting ? "shared.txt" : "theirs.txt"),
    conflicting ? "one\ntheirs\nthree\n" : "theirs\n",
    "utf8",
  );
  git(repoPath, "add", "--all");
  git(repoPath, "commit", "-m", "another pull request");
  const baseSha = git(repoPath, "rev-parse", "refs/heads/main");
  return { directory, repoPath, headSha, baseSha };
}

test("re-lands the head on the advanced base without touching the repository state", async () => {
  const fixture = relandingFixture({ conflicting: false });
  const worktrees = {
    root: join(fixture.directory, "reland"),
    head: join(fixture.directory, "reland", "integration"),
    base: join(fixture.directory, "reland", "unused"),
  };
  const before = {
    head: git(fixture.repoPath, "rev-parse", "HEAD"),
    base: git(fixture.repoPath, "rev-parse", "refs/heads/main"),
    feature: git(fixture.repoPath, "rev-parse", "refs/heads/feat/local"),
    status: git(fixture.repoPath, "status", "--porcelain"),
    stash: git(fixture.repoPath, "stash", "list"),
  };
  try {
    await relandHeadOnBase({
      repoPath: fixture.repoPath,
      worktreePath: worktrees.head,
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
      baseRef: "main",
    });

    // 現在の base の上に、 この PR の変更だけが載っている。
    assert.deepEqual(
      git(worktrees.head, "diff", "--cached", "--name-only").split(/\r?\n/).filter(Boolean),
      ["mine.txt"],
    );
    assert.equal(git(worktrees.head, "rev-parse", "HEAD"), fixture.baseSha);
    // 提出元ブランチの履歴も、 リポジトリの ref・index・作業ツリー・stash も動かない。
    assert.equal(git(fixture.repoPath, "rev-parse", "refs/heads/feat/local"), before.feature);
    assert.equal(git(fixture.repoPath, "rev-parse", "refs/heads/main"), before.base);
    assert.equal(git(fixture.repoPath, "rev-parse", "HEAD"), before.head);
    assert.equal(git(fixture.repoPath, "status", "--porcelain"), before.status);
    assert.equal(git(fixture.repoPath, "stash", "list"), before.stash);
  } finally {
    await cleanupWorktrees(fixture.repoPath, worktrees);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("a conflicting re-landing reports the conflicting files and resolves nothing", async () => {
  const fixture = relandingFixture({ conflicting: true });
  const worktrees = {
    root: join(fixture.directory, "reland"),
    head: join(fixture.directory, "reland", "integration"),
    base: join(fixture.directory, "reland", "unused"),
  };
  try {
    const error = await relandHeadOnBase({
      repoPath: fixture.repoPath,
      worktreePath: worktrees.head,
      baseSha: fixture.baseSha,
      headSha: fixture.headSha,
      baseRef: "main",
    }).then(() => null, (thrown) => thrown);

    assert.ok(error instanceof MergeConflictError, `unexpected result: ${error}`);
    assert.deepEqual(error.conflictedPaths, ["shared.txt"]);
    assert.match(error.message, /shared\.txt/);
    // 自動解決しない: 衝突は index に残したまま、 base ref も動かさない。
    assert.equal(git(fixture.repoPath, "rev-parse", "refs/heads/main"), fixture.baseSha);
  } finally {
    await cleanupWorktrees(fixture.repoPath, worktrees);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("rejects option-like object names before invoking Git", async () => {
  await assert.rejects(
    relandHeadOnBase({
      repoPath: "unused",
      worktreePath: "unused",
      baseSha: "--strategy=malicious",
      headSha: "a".repeat(40),
      baseRef: "main",
    }),
    /base_sha is not a Git object name/,
  );
  await assert.rejects(
    relandHeadOnBase({
      repoPath: "unused",
      worktreePath: "unused",
      baseSha: "a".repeat(40),
      headSha: "--strategy=malicious",
      baseRef: "main",
    }),
    /head_sha is not a Git object name/,
  );
});

test("quotes and bounds conflicting paths in the human-readable message", () => {
  const message = conflictMessage("main", ["line\nbreak.txt", "x".repeat(500)]);

  assert.doesNotMatch(message, /\n/);
  assert.match(message, /line\\nbreak\.txt/);
  assert.equal(message.includes("x".repeat(241)), false);
});

test("does not report a missing head object as a merge conflict", async () => {
  const fixture = relandingFixture({ conflicting: false });
  const worktrees = {
    root: join(fixture.directory, "reland"),
    head: join(fixture.directory, "reland", "integration"),
    base: join(fixture.directory, "reland", "unused"),
  };
  try {
    const error = await relandHeadOnBase({
      repoPath: fixture.repoPath,
      worktreePath: worktrees.head,
      baseSha: fixture.baseSha,
      headSha: "0".repeat(40),
      baseRef: "main",
    }).then(() => null, (thrown) => thrown);

    assert.ok(error instanceof Error);
    assert.equal(error instanceof MergeConflictError, false);
  } finally {
    await cleanupWorktrees(fixture.repoPath, worktrees);
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
