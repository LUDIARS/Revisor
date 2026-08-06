import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { MergeConflictError, StaleReviewError } from "../src/errors.mjs";
import { squashMergeLocalPullRequest } from "../src/local-merge.mjs";

function git(repoPath, ...args) {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

// main 1 コミット + feat/local 1 コミットの素の作業リポジトリ。
function repositoryFixture() {
  const directory = mkdtempSync(join(tmpdir(), "revisor-local-merge-"));
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
  writeFileSync(join(repoPath, "other.txt"), "other\n", "utf8");
  git(repoPath, "add", ".");
  git(repoPath, "commit", "-m", "base");
  git(repoPath, "checkout", "-b", "feat/local");
  writeFileSync(join(repoPath, "product.txt"), "base\nfeature\n", "utf8");
  git(repoPath, "add", "product.txt");
  git(repoPath, "commit", "-m", "feature");
  git(repoPath, "checkout", "main");
  return { directory, repoPath };
}

function mergeInput(fixture, overrides = {}) {
  const headSha = git(fixture.repoPath, "rev-parse", "refs/heads/feat/local");
  return {
    repository: { repository: "LUDIARS/Product", rootPath: fixture.repoPath },
    pullRequest: {
      id: "pr-1",
      status: "open",
      checkStatus: "test_ok",
      draft: false,
      title: "feature",
      body: "",
      headRef: "feat/local",
      baseRef: "main",
      headSha,
      baseSha: git(fixture.repoPath, "rev-parse", "refs/heads/main"),
      reviewedHeadSha: headSha,
      ...overrides,
    },
    scan: async () => ({ status: "passed" }),
    publish: async ({ mergeCommitSha }) => mergeCommitSha,
  };
}

test("merges even after the base advanced, as long as the squash applies cleanly", async () => {
  const fixture = repositoryFixture();
  try {
    const input = mergeInput(fixture);
    // 審査の後に base が別ファイルの変更で前進する (旧実装はここで必ず拒否した)。
    writeFileSync(join(fixture.repoPath, "other.txt"), "other\nmoved\n", "utf8");
    git(fixture.repoPath, "add", "other.txt");
    git(fixture.repoPath, "commit", "-m", "base moves");

    const mergeCommitSha = await squashMergeLocalPullRequest(input);

    assert.equal(git(fixture.repoPath, "rev-parse", "refs/heads/main"), mergeCommitSha);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("legacy draft metadata does not block a Test OK merge", async () => {
  const fixture = repositoryFixture();
  try {
    const mergeCommitSha = await squashMergeLocalPullRequest(
      mergeInput(fixture, { draft: true }),
    );
    assert.equal(git(fixture.repoPath, "rev-parse", "refs/heads/main"), mergeCommitSha);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("an explicit human override bypasses an unavailable pre-merge scanner", async () => {
  const fixture = repositoryFixture();
  try {
    const mergeCommitSha = await squashMergeLocalPullRequest({
      ...mergeInput(fixture),
      allowSystemFailureOverride: true,
      scan: async () => ({ status: "error", reason: "scanner executable missing" }),
    });
    assert.equal(git(fixture.repoPath, "rev-parse", "refs/heads/main"), mergeCommitSha);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("a human override never bypasses actual security findings", async () => {
  const fixture = repositoryFixture();
  try {
    await assert.rejects(
      squashMergeLocalPullRequest({
        ...mergeInput(fixture),
        allowSystemFailureOverride: true,
        scan: async () => ({
          status: "findings",
          totalFindings: 1,
          failOnSeverity: "high",
          reason: "finding remains",
        }),
      }),
      /security finding/,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("reuses a tagged prepared merge when publication is retried", async () => {
  const fixture = repositoryFixture();
  try {
    const input = mergeInput(fixture);
    const baseSha = git(fixture.repoPath, "rev-parse", "refs/heads/main");
    git(fixture.repoPath, "checkout", "--detach", baseSha);
    git(fixture.repoPath, "merge", "--squash", "refs/heads/feat/local");
    git(
      fixture.repoPath,
      "commit",
      "-m",
      "feature",
      "-m",
      `Revisor-Local-PR: ${input.pullRequest.id}`,
    );
    const preparedSha = git(fixture.repoPath, "rev-parse", "HEAD");
    git(fixture.repoPath, "tag", "-a", "v1.2.3", "-m", "prepared release");
    git(fixture.repoPath, "checkout", "main");

    const calls = [];
    const publication = await squashMergeLocalPullRequest({
      ...input,
      scan: async () => {
        throw new Error("a prepared merge must not be rebuilt or rescanned");
      },
      publish: async (request) => {
        calls.push(request);
        return {
          mergeCommitSha: request.mergeCommitSha,
          releaseTag: request.preparedTag,
          releaseUrl: "https://github.example/releases/v1.2.3",
        };
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].expectedBaseSha, baseSha);
    assert.equal(calls[0].mergeCommitSha, preparedSha);
    assert.equal(calls[0].preparedTag, "v1.2.3");
    assert.equal(publication.releaseTag, "v1.2.3");
    assert.equal(git(fixture.repoPath, "rev-parse", "refs/heads/main"), preparedSha);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("reuses an untagged prepared merge when ordinary publication is retried", async () => {
  const fixture = repositoryFixture();
  try {
    const input = mergeInput(fixture);
    let attempts = 0;
    await assert.rejects(
      squashMergeLocalPullRequest({
        ...input,
        publish: async () => {
          attempts += 1;
          throw new Error("publication interrupted");
        },
      }),
      /publication interrupted/,
    );

    const publication = await squashMergeLocalPullRequest({
      ...input,
      scan: async () => {
        throw new Error("a prepared ordinary merge must not be rebuilt or rescanned");
      },
      publish: async (request) => {
        attempts += 1;
        assert.equal(request.preparedTag, null);
        return {
          mergeCommitSha: request.mergeCommitSha,
          releaseTag: null,
          releaseUrl: null,
        };
      },
    });

    assert.equal(attempts, 2);
    assert.equal(publication.releaseTag, null);
    assert.equal(
      git(fixture.repoPath, "rev-parse", "refs/heads/main"),
      publication.mergeCommitSha,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("keeps the review when the head was only rebased (same patch content)", async () => {
  const fixture = repositoryFixture();
  try {
    const input = mergeInput(fixture);
    writeFileSync(join(fixture.repoPath, "other.txt"), "other\nmoved\n", "utf8");
    git(fixture.repoPath, "add", "other.txt");
    git(fixture.repoPath, "commit", "-m", "base moves");
    git(fixture.repoPath, "checkout", "feat/local");
    git(fixture.repoPath, "rebase", "main");
    git(fixture.repoPath, "checkout", "main");
    assert.notEqual(
      git(fixture.repoPath, "rev-parse", "refs/heads/feat/local"),
      input.pullRequest.reviewedHeadSha,
    );

    const mergeCommitSha = await squashMergeLocalPullRequest(input);

    assert.equal(git(fixture.repoPath, "rev-parse", "refs/heads/main"), mergeCommitSha);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("requires a new review when the head content changed after the review", async () => {
  const fixture = repositoryFixture();
  try {
    const input = mergeInput(fixture);
    git(fixture.repoPath, "checkout", "feat/local");
    writeFileSync(join(fixture.repoPath, "product.txt"), "base\nfeature\nunreviewed\n", "utf8");
    git(fixture.repoPath, "add", "product.txt");
    git(fixture.repoPath, "commit", "-m", "unreviewed change");
    git(fixture.repoPath, "checkout", "main");

    await assert.rejects(
      squashMergeLocalPullRequest(input),
      StaleReviewError,
    );
    assert.equal(
      git(fixture.repoPath, "rev-parse", "refs/heads/main"),
      input.pullRequest.baseSha,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("reports a conflict with the advanced base as a merge conflict", async () => {
  const fixture = repositoryFixture();
  try {
    const input = mergeInput(fixture);
    // base 側が同じ行を書き換える → squash はコンフリクトする。
    writeFileSync(join(fixture.repoPath, "product.txt"), "rewritten\n", "utf8");
    git(fixture.repoPath, "add", "product.txt");
    git(fixture.repoPath, "commit", "-m", "conflicting base change");
    const movedBase = git(fixture.repoPath, "rev-parse", "refs/heads/main");

    await assert.rejects(
      squashMergeLocalPullRequest(input),
      MergeConflictError,
    );
    assert.equal(git(fixture.repoPath, "rev-parse", "refs/heads/main"), movedBase);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
