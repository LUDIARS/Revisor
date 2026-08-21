import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  assertLocalVersionUnchanged,
  assertLocalVersionUnchangedAgainstRegisteredBase,
  initializeLocalVersion,
  inspectLocalVersionState,
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

test("bootstraps a missing registered version on the checked-out base only", async () => {
  const repoPath = mkdtempSync(join(tmpdir(), "revisor-version-bootstrap-"));
  try {
    git(repoPath, "init");
    git(repoPath, "checkout", "-b", "main");
    git(repoPath, "config", "user.name", "Test");
    git(repoPath, "config", "user.email", "test@example.invalid");
    writeFileSync(join(repoPath, "product.txt"), "base\n", "utf8");
    git(repoPath, "add", "product.txt");
    git(repoPath, "commit", "-m", "base");
    assert.deepEqual(await inspectLocalVersionState(repoPath), {
      status: "missing",
      version: null,
      managed: false,
    });
    assert.equal(await initializeLocalVersion(repoPath, "main", "2.4.0"), "2.4.0");
    assert.equal(git(repoPath, "show", `HEAD:${LOCAL_VERSION_FILE}`), UNINITIALIZED_VERSION);
    assert.equal(await readLocalVersion(repoPath), "2.4.0");
    assert.match(git(repoPath, "ls-files", "-t", "--", LOCAL_VERSION_FILE), /^S /);
    assert.equal(git(repoPath, "log", "-1", "--format=%s"), "chore: bootstrap Revisor version state");
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});

test("reports an unreachable registration instead of rejecting the projection", async () => {
  const missingPath = join(tmpdir(), "revisor-version-absent-root");
  rmSync(missingPath, { recursive: true, force: true });
  // The Releases, dashboard, and settings tables project every registration at
  // once, so a root path that moved away has to stay one bad row.
  const state = await inspectLocalVersionState(missingPath);
  assert.equal(state.status, "invalid");
  assert.equal(state.version, null);
  assert.equal(state.managed, false);
  assert.equal(typeof state.error, "string");
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

test("compares the version file against the registered base, not the frozen merge base", async () => {
  const registeredPath = mkdtempSync(join(tmpdir(), "revisor-version-registered-"));
  const mergePath = mkdtempSync(join(tmpdir(), "revisor-version-merge-"));
  try {
    git(registeredPath, "init");
    git(registeredPath, "checkout", "-b", "main");
    git(registeredPath, "config", "user.name", "Test");
    git(registeredPath, "config", "user.email", "test@example.invalid");
    writeFileSync(join(registeredPath, "product.txt"), "base\n", "utf8");
    git(registeredPath, "add", "product.txt");
    git(registeredPath, "commit", "-m", "base");
    // The isolated merge repository is cloned once and its base is never
    // refreshed afterwards, so it freezes a main that predates the version file.
    rmSync(mergePath, { recursive: true, force: true });
    git(registeredPath, "clone", "--no-checkout", "--", registeredPath, mergePath);
    git(mergePath, "config", "user.name", "Test");
    git(mergePath, "config", "user.email", "test@example.invalid");

    writeFileSync(join(registeredPath, LOCAL_VERSION_FILE), `${UNINITIALIZED_VERSION}\n`, "utf8");
    git(registeredPath, "add", LOCAL_VERSION_FILE);
    git(registeredPath, "commit", "-m", "chore: bootstrap Revisor version state");
    git(registeredPath, "checkout", "-b", "feat/product");
    writeFileSync(join(registeredPath, "product.txt"), "changed\n", "utf8");
    git(registeredPath, "add", "product.txt");
    git(registeredPath, "commit", "-m", "change product");
    git(mergePath, "fetch", "--no-tags", registeredPath, "+refs/heads/feat/product:refs/heads/feat/product");

    const frozenBaseSha = git(mergePath, "rev-parse", "--verify", "refs/heads/main");
    const headSha = git(mergePath, "rev-parse", "--verify", "refs/heads/feat/product");
    // The frozen base cannot tell "the registration committed the file" from
    // "this PR changed it", which is what used to stop every unrelated PR.
    await assert.rejects(
      assertLocalVersionUnchanged(mergePath, frozenBaseSha, headSha),
      /Revisor-owned local state/,
    );
    await assertLocalVersionUnchangedAgainstRegisteredBase(
      { rootPath: mergePath, registeredRootPath: registeredPath },
      { baseRef: "main", headRef: "feat/product" },
    );
  } finally {
    rmSync(registeredPath, { recursive: true, force: true });
    rmSync(mergePath, { recursive: true, force: true });
  }
});

test("still rejects a branch that changes the version file on the registered base", async () => {
  const repoPath = repositoryFixture();
  try {
    git(repoPath, "config", "user.name", "Test");
    git(repoPath, "config", "user.email", "test@example.invalid");
    git(repoPath, "checkout", "-b", "main");
    git(repoPath, "commit", "-m", "base");
    git(repoPath, "checkout", "-b", "feat/version-change");
    writeFileSync(join(repoPath, LOCAL_VERSION_FILE), "3.0.0\n", "utf8");
    git(repoPath, "add", LOCAL_VERSION_FILE);
    git(repoPath, "commit", "-m", "change managed version");
    await assert.rejects(
      assertLocalVersionUnchangedAgainstRegisteredBase(
        { rootPath: repoPath },
        { baseRef: "main", headRef: "feat/version-change" },
      ),
      /Revisor-owned local state/,
    );
  } finally {
    rmSync(repoPath, { recursive: true, force: true });
  }
});
