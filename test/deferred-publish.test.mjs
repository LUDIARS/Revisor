import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { squashMergeLocalPullRequest } from "../src/local-merge.mjs";
import { publishMergedPullRequest } from "../src/release-publisher.mjs";
import { publishPendingPublications } from "../src/publish-pending.mjs";
import { RevisorError } from "../src/errors.mjs";
import { NO_LFS_FILTER_ARGS } from "../src/workspace.mjs";

// 保留付きローカルマージ (`spec/plan/deferred-publish-design.md`)。
// GitHub App が入っていない org でも、 ローカルのマージだけは通常どおり終局し、
// 送出は pending ref に残って後から一括で送れる。

function git(repoPath, ...args) {
  const result = spawnSync("git", [...NO_LFS_FILTER_ARGS, "-C", repoPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

// src/pending-publish.mjs の導出と同じ。 ref そのものを検査するため、テスト側でも組む。
function pendingRefName(localPrId) {
  return `refs/revisor/pending-publish/${
    createHash("sha256").update(String(localPrId)).digest("hex")
  }`;
}

function refSha(repoPath, ref) {
  const result = spawnSync("git", ["-C", repoPath, "rev-parse", "--verify", ref], {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

// main 1 コミット (`.revisor-version` 込み) + feat/local 1 コミット。
function repositoryFixture() {
  const directory = mkdtempSync(join(tmpdir(), "revisor-deferred-publish-"));
  const repoPath = join(directory, "Product");
  const init = spawnSync("git", ["init", repoPath], { encoding: "utf8", windowsHide: true });
  if (init.status !== 0) throw new Error(init.stderr || init.stdout);
  git(repoPath, "checkout", "-b", "main");
  git(repoPath, "config", "user.name", "Test");
  git(repoPath, "config", "user.email", "test@example.invalid");
  writeFileSync(join(repoPath, "product.txt"), "base\n", "utf8");
  writeFileSync(join(repoPath, ".revisor-version"), "uninitialized\n", "utf8");
  git(repoPath, "add", ".");
  git(repoPath, "commit", "-m", "base");
  git(repoPath, "checkout", "-b", "feat/local");
  writeFileSync(join(repoPath, "product.txt"), "base\nfeature\n", "utf8");
  git(repoPath, "add", "product.txt");
  git(repoPath, "commit", "-m", "feature");
  git(repoPath, "checkout", "main");
  return { directory, repoPath };
}

function installationNotFound() {
  const error = new RevisorError(
    "GitHub API GET /repos/MELPOT/Product/installation returned 404: Not Found",
  );
  error.status = 404;
  error.apiPath = "/repos/MELPOT/Product/installation";
  return error;
}

function mergeInput(fixture, { publish, deferPush = false } = {}) {
  const headSha = git(fixture.repoPath, "rev-parse", "refs/heads/feat/local");
  return {
    repository: {
      repository: "MELPOT/Product",
      rootPath: fixture.repoPath,
      registeredRootPath: fixture.repoPath,
      baseRef: "main",
    },
    pullRequest: {
      id: "pr-1",
      status: "open",
      checkStatus: "test_ok",
      title: "feature",
      body: "",
      headRef: "feat/local",
      baseRef: "main",
      headSha,
      baseSha: git(fixture.repoPath, "rev-parse", "refs/heads/main"),
      reviewedHeadSha: headSha,
    },
    scan: async () => ({ status: "passed" }),
    ...(deferPush ? { deferPush: true } : {}),
    ...(publish ? { publish } : {}),
    log: () => {},
  };
}

// 実 publish を、注入した GitHub クライアントだけで動かす。
function realPublish({ createClient, calls = [] }) {
  return async (request) => {
    calls.push(request);
    return publishMergedPullRequest({
      ...request,
      readCredentials: () => ({ appId: "1", privateKey: "key" }),
      createClient,
    });
  };
}

test("an uninstalled GitHub App defers the publish and still completes the local merge", async () => {
  const fixture = repositoryFixture();
  try {
    let tokenRequests = 0;
    const publication = await squashMergeLocalPullRequest(mergeInput(fixture, {
      publish: realPublish({
        createClient: () => ({
          installationToken: async () => {
            tokenRequests += 1;
            throw installationNotFound();
          },
          releaseByTag: async () => assert.fail("a deferred publish must not read Releases"),
          createRelease: async () => assert.fail("a deferred publish must not create a Release"),
        }),
      }),
    }));

    assert.equal(tokenRequests, 1);
    assert.equal(publication.publication, "deferred");
    assert.equal(publication.releaseTag, null);
    // ローカル側は通常マージと同じ終局状態。
    assert.equal(
      git(fixture.repoPath, "rev-parse", "refs/heads/main"),
      publication.mergeCommitSha,
    );
    assert.equal(
      refSha(fixture.repoPath, pendingRefName("pr-1")),
      publication.mergeCommitSha,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("--defer-push holds the publish without touching the GitHub client at all", async () => {
  const fixture = repositoryFixture();
  try {
    const publication = await squashMergeLocalPullRequest(mergeInput(fixture, {
      deferPush: true,
      publish: realPublish({
        createClient: () => assert.fail("an explicit deferral must not build a GitHub client"),
      }),
    }));

    assert.equal(publication.publication, "deferred");
    assert.match(publication.deferredReason, /--defer-push/);
    assert.equal(
      git(fixture.repoPath, "rev-parse", "refs/heads/main"),
      publication.mergeCommitSha,
    );
    assert.equal(
      refSha(fixture.repoPath, pendingRefName("pr-1")),
      publication.mergeCommitSha,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("a GitHub failure other than an uninstalled App still fails the merge", async () => {
  const fixture = repositoryFixture();
  try {
    const baseSha = git(fixture.repoPath, "rev-parse", "refs/heads/main");
    const serverError = new RevisorError(
      "GitHub API GET /repos/MELPOT/Product/installation returned 500: Server Error",
    );
    serverError.status = 500;
    serverError.apiPath = "/repos/MELPOT/Product/installation";

    await assert.rejects(
      squashMergeLocalPullRequest(mergeInput(fixture, {
        publish: realPublish({
          createClient: () => ({
            installationToken: async () => {
              throw serverError;
            },
          }),
        }),
      })),
      /returned 500/,
    );

    // 障害を保留で隠さない: ローカル main は前進せず、 保留の記録も残さない。
    assert.equal(git(fixture.repoPath, "rev-parse", "refs/heads/main"), baseSha);
    assert.equal(refSha(fixture.repoPath, pendingRefName("pr-1")), null);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

// publish-pending は state と merge repository を突き合わせるだけなので、
// 記録は最小の代役で足りる。
function storeFixture(fixture, pullRequestOverrides = {}) {
  const pullRequests = [{
    id: "pr-1",
    number: 433,
    repository: "MELPOT/Product",
    baseRef: "main",
    status: "merged",
    publication: "deferred",
    releaseTag: null,
    ...pullRequestOverrides,
  }];
  const updates = [];
  return {
    updates,
    pullRequests,
    store: {
      path: join(fixture.directory, "revisor.state.json"),
      listRepositories: () => [{
        repository: "MELPOT/Product",
        rootPath: fixture.repoPath,
        baseRef: "main",
      }],
      listPullRequests: () => pullRequests.map((pullRequest) => ({ ...pullRequest })),
      updatePullRequest: (id, patch) => {
        updates.push({ id, patch });
        return { ...pullRequests[0], ...patch };
      },
    },
  };
}

test("publish-pending sends a held merge and drops its pending ref", async () => {
  const fixture = repositoryFixture();
  try {
    const merge = await squashMergeLocalPullRequest(mergeInput(fixture, { deferPush: true }));
    const { store, updates } = storeFixture(fixture);
    const requests = [];

    const summary = await publishPendingPublications({
      store,
      env: {},
      resolveMergeRoot: () => fixture.repoPath,
      publish: async (request) => {
        requests.push(request);
        return {
          mergeCommitSha: request.mergeCommitSha,
          releaseTag: null,
          releaseUrl: null,
          publication: "published",
        };
      },
    });

    assert.deepEqual(
      [summary.pending, summary.published, summary.skipped, summary.failed],
      [1, 1, 0, 0],
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0].mergeCommitSha, merge.mergeCommitSha);
    assert.equal(
      requests[0].expectedBaseSha,
      git(fixture.repoPath, "rev-parse", `${merge.mergeCommitSha}^`),
    );
    assert.equal(requests[0].pullRequest.number, 433);
    assert.equal(refSha(fixture.repoPath, pendingRefName("pr-1")), null);
    assert.equal(updates[0].patch.publication, "published");
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("publish-pending sends dependent deferred merges in local merge order", async () => {
  const fixture = repositoryFixture();
  try {
    const firstMerge = await squashMergeLocalPullRequest(mergeInput(fixture, { deferPush: true }));
    writeFileSync(join(fixture.repoPath, "product.txt"), "base\nfeature\nsecond\n", "utf8");
    git(fixture.repoPath, "add", "product.txt");
    git(fixture.repoPath, "commit", "-m", "second deferred merge");
    const secondMerge = git(fixture.repoPath, "rev-parse", "HEAD");
    git(fixture.repoPath, "update-ref", pendingRefName("pr-2"), secondMerge);
    const { store } = storeFixture(fixture);
    const published = [];

    const summary = await publishPendingPublications({
      store,
      env: {},
      resolveMergeRoot: () => fixture.repoPath,
      publish: async (request) => {
        published.push(request.mergeCommitSha);
        return {
          mergeCommitSha: request.mergeCommitSha,
          releaseTag: null,
          releaseUrl: null,
          publication: "published",
        };
      },
    });

    assert.deepEqual(published, [firstMerge.mergeCommitSha, secondMerge]);
    assert.deepEqual(
      [summary.pending, summary.published, summary.skipped, summary.failed],
      [2, 2, 0, 0],
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("publish-pending keeps the pending ref while GitHub stays unreachable", async () => {
  const fixture = repositoryFixture();
  try {
    const merge = await squashMergeLocalPullRequest(mergeInput(fixture, { deferPush: true }));
    const { store, updates } = storeFixture(fixture);

    const summary = await publishPendingPublications({
      store,
      env: {},
      resolveMergeRoot: () => fixture.repoPath,
      publish: async (request) => ({
        mergeCommitSha: request.mergeCommitSha,
        releaseTag: null,
        releaseUrl: null,
        publication: "deferred",
        deferredReason: "The GitHub App is not installed for MELPOT/Product.",
      }),
    });

    assert.deepEqual(
      [summary.pending, summary.published, summary.skipped, summary.failed],
      [1, 0, 1, 0],
    );
    assert.match(summary.entries[0].reason, /not installed/);
    assert.equal(refSha(fixture.repoPath, pendingRefName("pr-1")), merge.mergeCommitSha);
    assert.equal(updates.length, 0);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
