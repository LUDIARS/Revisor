import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { squashMergeLocalPullRequest } from "../src/local-merge.mjs";
import {
  prepareMergeRepository,
  resolveMergeRepositoryPath,
} from "../src/merge-repository.mjs";

function git(repoPath, ...args) {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function repositoryFixture() {
  const directory = mkdtempSync(join(tmpdir(), "revisor-merge-repository-"));
  const sourceRoot = join(directory, "Product");
  const init = spawnSync("git", ["init", sourceRoot], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (init.status !== 0) throw new Error(init.stderr || init.stdout);
  git(sourceRoot, "checkout", "-b", "main");
  git(sourceRoot, "config", "user.name", "Test");
  git(sourceRoot, "config", "user.email", "test@example.invalid");
  writeFileSync(join(sourceRoot, ".gitignore"), "generated/\n", "utf8");
  writeFileSync(join(sourceRoot, ".revisor-version"), "0.1.0\n", "utf8");
  writeFileSync(join(sourceRoot, "product.txt"), "base\n", "utf8");
  git(sourceRoot, "add", ".");
  git(sourceRoot, "commit", "-m", "base");
  const baseSha = git(sourceRoot, "rev-parse", "HEAD");
  git(sourceRoot, "checkout", "-b", "feat/local");
  writeFileSync(join(sourceRoot, "product.txt"), "base\nfeature\n", "utf8");
  git(sourceRoot, "add", "product.txt");
  git(sourceRoot, "commit", "-m", "feature");
  const headSha = git(sourceRoot, "rev-parse", "HEAD");
  git(sourceRoot, "checkout", "main");
  return { directory, sourceRoot, baseSha, headSha };
}

test("isolates merge, reconciliation, and publication state from a dirty source checkout", async () => {
  const fixture = repositoryFixture();
  const statePath = join(fixture.directory, "state", "revisor.state.json");
  const repository = {
    repository: "LUDIARS/Product",
    rootPath: fixture.sourceRoot,
  };
  const pullRequest = {
    id: "pr-isolated",
    number: 324,
    status: "open",
    checkStatus: "test_ok",
    title: "isolated merge",
    body: "",
    headRef: "feat/local",
    baseRef: "main",
    headSha: fixture.headSha,
    baseSha: fixture.baseSha,
    reviewedHeadSha: fixture.headSha,
  };
  try {
    // Reproduce the operational condition that made `stash push --all` time
    // out: tracked edits plus untracked and ignored generated content.
    writeFileSync(join(fixture.sourceRoot, "product.txt"), "base\nuser edit\n", "utf8");
    writeFileSync(join(fixture.sourceRoot, "notes.txt"), "untracked\n", "utf8");
    mkdirSync(join(fixture.sourceRoot, "generated"), { recursive: true });
    writeFileSync(join(fixture.sourceRoot, "generated", "large-cache.txt"), "ignored\n", "utf8");
    const sourceBefore = {
      branch: git(fixture.sourceRoot, "branch", "--show-current"),
      baseSha: git(fixture.sourceRoot, "rev-parse", "refs/heads/main"),
      status: git(fixture.sourceRoot, "status", "--porcelain", "--ignored"),
      stashes: git(fixture.sourceRoot, "stash", "list"),
    };

    const mergeRepository = await prepareMergeRepository({
      repository,
      pullRequest,
      statePath,
    });
    const publication = await squashMergeLocalPullRequest({
      repository: mergeRepository,
      pullRequest,
      scan: async () => ({ status: "passed" }),
      publish: async ({ mergeCommitSha }) => ({
        mergeCommitSha,
        releaseTag: null,
        releaseUrl: null,
      }),
    });

    assert.equal(
      mergeRepository.rootPath,
      resolveMergeRepositoryPath({ repository, statePath }),
    );
    assert.notEqual(mergeRepository.rootPath, fixture.sourceRoot);
    assert.equal(
      git(mergeRepository.rootPath, "rev-parse", "refs/heads/main"),
      publication.mergeCommitSha,
    );
    assert.equal(git(mergeRepository.rootPath, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD");
    assert.deepEqual({
      branch: git(fixture.sourceRoot, "branch", "--show-current"),
      baseSha: git(fixture.sourceRoot, "rev-parse", "refs/heads/main"),
      status: git(fixture.sourceRoot, "status", "--porcelain", "--ignored"),
      stashes: git(fixture.sourceRoot, "stash", "list"),
    }, sourceBefore);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("reuses its persistent base while refreshing only the source head", async () => {
  const fixture = repositoryFixture();
  const statePath = join(fixture.directory, "state", "revisor.state.json");
  const repository = {
    repository: "LUDIARS/Product",
    rootPath: fixture.sourceRoot,
  };
  const pullRequest = {
    headRef: "feat/local",
    baseRef: "main",
  };
  try {
    const first = await prepareMergeRepository({ repository, pullRequest, statePath });
    const ownedBase = git(first.rootPath, "rev-parse", "refs/heads/main");
    git(first.rootPath, "update-ref", "refs/heads/main", fixture.headSha, ownedBase);

    git(fixture.sourceRoot, "checkout", "feat/local");
    writeFileSync(join(fixture.sourceRoot, "next.txt"), "next\n", "utf8");
    git(fixture.sourceRoot, "add", "next.txt");
    git(fixture.sourceRoot, "commit", "-m", "next head");
    const nextHead = git(fixture.sourceRoot, "rev-parse", "HEAD");
    git(fixture.sourceRoot, "checkout", "main");

    const second = await prepareMergeRepository({ repository, pullRequest, statePath });
    assert.equal(second.rootPath, first.rootPath);
    assert.equal(git(second.rootPath, "rev-parse", "refs/heads/main"), fixture.headSha);
    assert.equal(git(second.rootPath, "rev-parse", "refs/heads/feat/local"), nextHead);
    assert.equal(git(fixture.sourceRoot, "rev-parse", "refs/heads/main"), fixture.baseSha);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
