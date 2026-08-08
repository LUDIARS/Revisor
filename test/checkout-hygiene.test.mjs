import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { restoreBaseCheckout } from "../src/checkout-hygiene.mjs";

function git(repoPath, ...args) {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

// main 1 コミット + feat/debris 1 コミットの素の作業リポジトリ。
function repositoryFixture() {
  const directory = mkdtempSync(join(tmpdir(), "revisor-checkout-hygiene-"));
  const repoPath = join(directory, "Product");
  const init = spawnSync("git", ["init", repoPath], { encoding: "utf8", windowsHide: true });
  if (init.status !== 0) throw new Error(init.stderr || init.stdout);
  git(repoPath, "checkout", "-b", "main");
  git(repoPath, "config", "user.name", "Test");
  git(repoPath, "config", "user.email", "test@example.invalid");
  writeFileSync(join(repoPath, "product.txt"), "base\n", "utf8");
  writeFileSync(join(repoPath, ".gitignore"), "session.log\n", "utf8");
  git(repoPath, "add", ".");
  git(repoPath, "commit", "-m", "base");
  git(repoPath, "checkout", "-b", "feat/debris");
  writeFileSync(join(repoPath, "product.txt"), "base\nfeature\n", "utf8");
  git(repoPath, "add", "product.txt");
  git(repoPath, "commit", "-m", "feature");
  return { directory, repoPath };
}

test("restores the base ref and stashes edits a session left behind", async () => {
  const { directory, repoPath } = repositoryFixture();
  try {
    // 残骸: head ブランチのまま、追跡・未追跡・ignored ファイル。
    writeFileSync(join(repoPath, "product.txt"), "base\nfeature\ndebris\n", "utf8");
    writeFileSync(join(repoPath, "scratch.txt"), "scratch\n", "utf8");
    writeFileSync(join(repoPath, "session.log"), "ignored scratch\n", "utf8");

    const report = await restoreBaseCheckout({ rootPath: repoPath, baseRef: "main" });

    assert.deepEqual(report, { previousRef: "feat/debris", stashed: true, switched: true });
    assert.equal(git(repoPath, "rev-parse", "--abbrev-ref", "HEAD"), "main");
    assert.equal(git(repoPath, "status", "--porcelain"), "");
    // 残骸は消えていない — stash に退避されている。
    const stashes = git(repoPath, "stash", "list");
    assert.match(stashes, /revisor-checkout-hygiene .* \(feat\/debris\)/);
    assert.equal(existsSync(join(repoPath, "scratch.txt")), false);
    assert.equal(existsSync(join(repoPath, "session.log")), false);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10 });
  }
});

test("leaves a clean base checkout untouched", async () => {
  const { directory, repoPath } = repositoryFixture();
  try {
    git(repoPath, "checkout", "main");
    const report = await restoreBaseCheckout({ rootPath: repoPath, baseRef: "main" });
    assert.deepEqual(report, { previousRef: "main", stashed: false, switched: false });
    assert.equal(git(repoPath, "stash", "list"), "");
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10 });
  }
});

test("returns from a detached HEAD to the base ref", async () => {
  const { directory, repoPath } = repositoryFixture();
  try {
    git(repoPath, "checkout", "--detach", "HEAD");
    const report = await restoreBaseCheckout({ rootPath: repoPath, baseRef: "main" });
    assert.equal(report.previousRef, "HEAD");
    assert.equal(report.switched, true);
    assert.equal(git(repoPath, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10 });
  }
});

test("rejects a base ref that could be parsed as a checkout option", async () => {
  await assert.rejects(
    restoreBaseCheckout({ rootPath: "unused", baseRef: "--orphan" }),
    /base_ref is not a safe Git ref/,
  );
});
