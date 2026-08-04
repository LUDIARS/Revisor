import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  assertLocalVersionUnchanged,
  LOCAL_VERSION_FILE,
  prepareLocalVersionFile,
  readLocalVersion,
  UNINITIALIZED_VERSION,
  writeLocalVersion,
} from "../src/local-version.mjs";

function git(repoPath, ...args) {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function repositoryFixture() {
  const repoPath = mkdtempSync(join(tmpdir(), "revisor-version-"));
  const init = spawnSync("git", ["init", repoPath], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (init.status !== 0) throw new Error(init.stderr || init.stdout);
  writeFileSync(join(repoPath, LOCAL_VERSION_FILE), `${UNINITIALIZED_VERSION}\n`, "utf8");
  git(repoPath, "add", LOCAL_VERSION_FILE);
  return repoPath;
}

test("prepares a tracked local version as skip-worktree state", async () => {
  const repoPath = repositoryFixture();
  try {
    assert.equal(await prepareLocalVersionFile(repoPath), UNINITIALIZED_VERSION);
    assert.match(git(repoPath, "ls-files", "-t", "--", LOCAL_VERSION_FILE), /^S /);
    assert.equal(
      await readLocalVersion(repoPath, { allowUninitialized: true }),
      UNINITIALIZED_VERSION,
    );
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("writes the explicitly selected version and retains local management", async () => {
  const repoPath = repositoryFixture();
  try {
    assert.equal(await writeLocalVersion(repoPath, "v2.4.0"), "2.4.0");
    assert.equal(await readLocalVersion(repoPath), "2.4.0");
    assert.match(git(repoPath, "ls-files", "-t", "--", LOCAL_VERSION_FILE), /^S /);
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("rejects a version-file change from a feature branch", async () => {
  const repoPath = repositoryFixture();
  try {
    git(repoPath, "config", "user.name", "Test");
    git(repoPath, "config", "user.email", "test@example.invalid");
    git(repoPath, "commit", "-m", "base");
    const baseSha = git(repoPath, "rev-parse", "HEAD");
    git(repoPath, "checkout", "-b", "feat/version-change");
    writeFileSync(join(repoPath, LOCAL_VERSION_FILE), "3.0.0\n", "utf8");
    git(repoPath, "add", LOCAL_VERSION_FILE);
    git(repoPath, "commit", "-m", "change managed version");
    const headSha = git(repoPath, "rev-parse", "HEAD");
    await assert.rejects(
      assertLocalVersionUnchanged(repoPath, baseSha, headSha),
      /Revisor-owned local state/,
    );
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});
