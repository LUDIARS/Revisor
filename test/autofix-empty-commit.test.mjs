import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { commitAndAdvanceAutofix } from "../src/runner.mjs";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

function git(repoPath, ...args) {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "revisor-autofix-commit-"));
  const repoPath = join(directory, "Product");
  const init = spawnSync("git", ["init", repoPath], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (init.status !== 0) throw new Error(init.stderr || init.stdout);
  git(repoPath, "checkout", "-b", "main");
  writeFileSync(join(repoPath, "product.txt"), "base\n", "utf8");
  git(repoPath, "add", "--", "product.txt");
  git(
    repoPath,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "base",
  );
  return { directory, repoPath };
}

test("autofix が実際に差分を作ったらコミットしてヘッドを進める", async () => {
  const { directory, repoPath } = fixture();
  try {
    // 実物と同じ形にする: 審査は detach した使い捨て worktree の中で走り、
    // 登録元 checkout の branch は advanceLocalBranch が CAS で進める。
    const headSha = git(repoPath, "rev-parse", "HEAD");
    const worktreePath = join(directory, "review");
    git(repoPath, "worktree", "add", "--detach", worktreePath, headSha);

    writeFileSync(join(worktreePath, "product.txt"), "fixed\n", "utf8");
    const reviewedHeadSha = await commitAndAdvanceAutofix(worktreePath, repoPath, {
      headSha,
      headRef: "main",
    });

    assert.notEqual(reviewedHeadSha, headSha);
    assert.equal(git(repoPath, "rev-parse", "main"), reviewedHeadSha);
    assert.match(
      git(worktreePath, "log", "-1", "--format=%s"),
      /apply automated review fixes/,
    );
  } finally {
    removeFixture(directory);
  }
});

/**
 * `status --porcelain` が非空でも、 `add` の後に stage が空になることがある。
 * autocrlf の正規化がその典型で、 そのまま commit すると「nothing to commit」で
 * 非ゼロ終了し、 審査全体が git の失敗として落ちていた (#444)。
 */
test("status は非空でも stage が空なら commit せず、ヘッドも動かさない", async () => {
  const { directory, repoPath } = fixture();
  try {
    // 作業ツリーだけ CRLF にして、 index へ入れると LF へ戻る状態を作る。
    git(repoPath, "config", "core.autocrlf", "input");
    writeFileSync(join(repoPath, "product.txt"), "base\r\n", "utf8");
    assert.ok(
      git(repoPath, "status", "--porcelain").trim(),
      "前提: status は変更ありと報告する",
    );

    const headSha = git(repoPath, "rev-parse", "HEAD");
    const reviewedHeadSha = await commitAndAdvanceAutofix(repoPath, null, {
      headSha,
      headRef: "main",
    });

    assert.equal(reviewedHeadSha, headSha);
    assert.equal(git(repoPath, "rev-parse", "HEAD"), headSha);
  } finally {
    removeFixture(directory);
  }
});
