import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { NO_LFS_FILTER_ARGS } from "../src/workspace.mjs";
import { probeBaseMergeability } from "../src/submit-probe.mjs";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

function git(repoPath, ...args) {
  const result = spawnSync("git", [...NO_LFS_FILTER_ARGS, "-C", repoPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

/** base に 1 コミット、そこから分岐した head を持つリポジトリを作る。 */
function repositoryFixture({ conflicting }) {
  const directory = mkdtempSync(join(tmpdir(), "revisor-submit-probe-"));
  const repoPath = join(directory, "repo");
  git(directory, "init", "--quiet", "repo");
  git(repoPath, "config", "user.email", "test@localhost");
  git(repoPath, "config", "user.name", "test");
  writeFileSync(join(repoPath, "shared.txt"), "base\n", "utf8");
  git(repoPath, "add", ".");
  git(repoPath, "commit", "--quiet", "-m", "base");
  git(repoPath, "branch", "-M", "main");

  git(repoPath, "checkout", "--quiet", "-b", "feat/head");
  writeFileSync(join(repoPath, conflicting ? "shared.txt" : "own.txt"), "head\n", "utf8");
  git(repoPath, "add", ".");
  git(repoPath, "commit", "--quiet", "-m", "head");
  const headSha = git(repoPath, "rev-parse", "HEAD");

  // base だけを進める。 conflicting なら head と同じ行を触る。
  git(repoPath, "checkout", "--quiet", "main");
  writeFileSync(join(repoPath, "shared.txt"), "moved\n", "utf8");
  git(repoPath, "add", ".");
  git(repoPath, "commit", "--quiet", "-m", "base moved");

  return { directory, mergeRepository: { rootPath: repoPath }, headSha };
}

test("a head that still lands on the advanced base is clean", async () => {
  const fixture = repositoryFixture({ conflicting: false });
  try {
    const probe = await probeBaseMergeability({
      mergeRepository: fixture.mergeRepository,
      baseRef: "main",
      headSha: fixture.headSha,
    });
    assert.equal(probe.status, "clean");
    assert.deepEqual(probe.conflictedPaths, []);
  } finally {
    removeFixture(fixture.directory);
  }
});

// 早期検知の本体。 載らない head を審査へ通すと、モデルレビューもテストも走らせた末に
// 取り込みで落ちる。 提出直後に、衝突したファイルまで含めて返せること。
test("a head that conflicts with the advanced base is reported with its paths", async () => {
  const fixture = repositoryFixture({ conflicting: true });
  try {
    const probe = await probeBaseMergeability({
      mergeRepository: fixture.mergeRepository,
      baseRef: "main",
      headSha: fixture.headSha,
    });
    assert.equal(probe.status, "conflict");
    assert.deepEqual(probe.conflictedPaths, ["shared.txt"]);
    assert.match(probe.reason, /shared\.txt/);
  } finally {
    removeFixture(fixture.directory);
  }
});

// 判定できなかったことを衝突と報告しない。 提出そのものも塞がない。
test("an unreadable base is reported as unknown rather than as a conflict", async () => {
  const fixture = repositoryFixture({ conflicting: false });
  try {
    const probe = await probeBaseMergeability({
      mergeRepository: fixture.mergeRepository,
      baseRef: "does-not-exist",
      headSha: fixture.headSha,
    });
    assert.equal(probe.status, "unknown");
    assert.deepEqual(probe.conflictedPaths, []);
  } finally {
    removeFixture(fixture.directory);
  }
});

// 判定は使い捨て worktree の中だけ。 merge repository の ref も作業ツリーも動かさない。
test("probing leaves the merge repository refs and worktree untouched", async () => {
  const fixture = repositoryFixture({ conflicting: true });
  const repoPath = fixture.mergeRepository.rootPath;
  try {
    const before = {
      main: git(repoPath, "rev-parse", "refs/heads/main"),
      head: git(repoPath, "rev-parse", "HEAD"),
      status: git(repoPath, "status", "--porcelain"),
    };
    await probeBaseMergeability({
      mergeRepository: fixture.mergeRepository,
      baseRef: "main",
      headSha: fixture.headSha,
    });
    assert.equal(git(repoPath, "rev-parse", "refs/heads/main"), before.main);
    assert.equal(git(repoPath, "rev-parse", "HEAD"), before.head);
    assert.equal(git(repoPath, "status", "--porcelain"), before.status);
  } finally {
    removeFixture(fixture.directory);
  }
});
