import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { LocalPrReporter } from "../src/local-reporter.mjs";
import { LocalPrService } from "../src/local-pr-service.mjs";
import { PrReviewQueue } from "../src/queue.mjs";
import { LocalPrStore } from "../src/state-store.mjs";

async function waitForCheckStatus(store, id, checkStatus) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const pullRequest = store.getPullRequest(id);
    if (pullRequest.checkStatus === checkStatus) return pullRequest;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Local PR never reached '${checkStatus}'.`);
}

async function releaseRun(releases) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const resolve = releases.shift();
    if (resolve) {
      resolve();
      return;
    }
    await new Promise((settle) => setImmediate(settle));
  }
  throw new Error("The review run never started.");
}

function git(repoPath, ...args) {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function repositoryFixture() {
  const directory = mkdtempSync(join(tmpdir(), "revisor-local-pr-"));
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
  const baseSha = git(repoPath, "rev-parse", "HEAD");
  git(repoPath, "checkout", "-b", "feat/local");
  writeFileSync(join(repoPath, "product.txt"), "base\nfeature\n", "utf8");
  git(repoPath, "add", "product.txt");
  git(repoPath, "commit", "-m", "feature one");
  writeFileSync(join(repoPath, "extra.txt"), "feature two\n", "utf8");
  git(repoPath, "add", "extra.txt");
  git(repoPath, "commit", "-m", "feature two");
  git(repoPath, "checkout", "main");
  return { directory, repoPath, baseSha };
}

test("registers tests, queues a local-only PR, and squash merges it", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  let queued;
  const service = new LocalPrService({
    store,
    queue: {
      async submit(request) {
        queued = request;
        return { id: "job-1" };
      },
    },
    installGuard: async () => join(fixture.repoPath, ".git", "hooks", "pre-push"),
  });
  try {
    await service.registerRepository({
      repository: "LUDIARS/Product",
      rootPath: fixture.repoPath,
      baseRef: "main",
      testCases: [{
        name: "unit",
        command: "node",
        args: ["--test"],
        cwd: ".",
        timeoutMs: 60_000,
      }],
    });
    const pullRequest = await service.submitPullRequest({
      repository: "LUDIARS/Product",
      title: "Add product feature",
      body: "Two local commits become one.",
      author: "neco",
      headRef: "feat/local",
    });
    assert.equal(queued.headSha, git(fixture.repoPath, "rev-parse", "feat/local"));
    assert.equal(queued.rootPath, fixture.repoPath);
    assert.equal(queued.testCases.length, 1);
    assert.equal(git(fixture.repoPath, "branch", "-r"), "");

    store.updatePullRequest(pullRequest.id, {
      checkStatus: "test_ok",
      reviewedHeadSha: queued.headSha,
    });
    const merged = await service.mergePullRequest(pullRequest.id);
    assert.equal(merged.status, "merged");
    assert.equal(
      readFileSync(join(fixture.repoPath, "product.txt"), "utf8").replace(/\r\n/g, "\n"),
      "base\nfeature\n",
    );
    assert.equal(git(fixture.repoPath, "rev-list", "--count", "main"), "2");
    assert.equal(git(fixture.repoPath, "log", "-1", "--format=%P"), fixture.baseSha);
    assert.match(git(fixture.repoPath, "log", "-1", "--format=%B"), /Revisor-Local-PR/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("re-queues a failed local PR against the current branch heads", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  const submitted = [];
  const service = new LocalPrService({
    store,
    queue: {
      async submit(request) {
        submitted.push(request);
        return { id: `job-${submitted.length}` };
      },
    },
    installGuard: async () => join(fixture.repoPath, ".git", "hooks", "pre-push"),
  });
  try {
    await service.registerRepository({
      repository: "LUDIARS/Product",
      rootPath: fixture.repoPath,
      baseRef: "main",
      testCases: [{
        name: "unit",
        command: "node",
        args: ["--test"],
        cwd: ".",
        timeoutMs: 60_000,
      }],
    });
    const pullRequest = await service.submitPullRequest({
      repository: "LUDIARS/Product",
      title: "Add product feature",
      author: "neco",
      headRef: "feat/local",
    });
    store.updatePullRequest(pullRequest.id, {
      checkStatus: "failed",
      error: "Anatomia PR analysis failed",
    });

    git(fixture.repoPath, "checkout", "feat/local");
    writeFileSync(join(fixture.repoPath, "extra.txt"), "feature three\n", "utf8");
    git(fixture.repoPath, "add", "extra.txt");
    git(fixture.repoPath, "commit", "-m", "feature three");
    git(fixture.repoPath, "checkout", "main");
    const movedHead = git(fixture.repoPath, "rev-parse", "feat/local");

    const retried = await service.retryPullRequest(pullRequest.id);
    assert.equal(submitted.length, 2);
    assert.equal(submitted[1].headSha, movedHead);
    assert.equal(retried.headSha, movedHead);
    assert.equal(retried.checkStatus, "queued");
    assert.equal(retried.error, null);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("re-reviews an unchanged head and drops the previous outcome", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  const runs = [];
  const releases = [];
  const queue = new PrReviewQueue(async (request) => {
    runs.push(request.headSha);
    await new Promise((resolve) => releases.push(resolve));
    return {
      conclusion: "action_required",
      reviewedHeadSha: request.headSha,
      reviewer: "codex-sol",
      ci: [{ name: "unit", status: "failed", exitCode: 1, durationMs: 12 }],
      reasons: ["unit failed"],
    };
  }, { concurrency: 1, reporter: new LocalPrReporter(store) });
  const service = new LocalPrService({
    store,
    queue,
    installGuard: async () => join(fixture.repoPath, ".git", "hooks", "pre-push"),
  });
  try {
    await service.registerRepository({
      repository: "LUDIARS/Product",
      rootPath: fixture.repoPath,
      baseRef: "main",
      testCases: [{
        name: "unit",
        command: "node",
        args: ["--test"],
        cwd: ".",
        timeoutMs: 60_000,
      }],
    });
    const submitted = await service.submitPullRequest({
      repository: "LUDIARS/Product",
      title: "Add product feature",
      author: "neco",
      headRef: "feat/local",
    });
    await releaseRun(releases);
    const reviewed = await waitForCheckStatus(store, submitted.id, "action_required");
    assert.equal(reviewed.reviewedHeadSha, submitted.headSha);

    // The head has not moved, so the queue holds a settled job under this key.
    const retried = await service.retryPullRequest(submitted.id);
    assert.equal(retried.headSha, submitted.headSha);
    assert.equal(retried.reviewedHeadSha, null);
    assert.equal(retried.reviewer, null);
    assert.deepEqual(retried.ci, []);
    assert.deepEqual(retried.reasons, []);

    await releaseRun(releases);
    await waitForCheckStatus(store, submitted.id, "action_required");
    assert.deepEqual(runs, [submitted.headSha, submitted.headSha]);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("refuses to re-queue a merged local PR", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  const service = new LocalPrService({
    store,
    queue: { async submit() { return { id: "job-1" }; } },
    installGuard: async () => join(fixture.repoPath, ".git", "hooks", "pre-push"),
  });
  try {
    await service.registerRepository({
      repository: "LUDIARS/Product",
      rootPath: fixture.repoPath,
      baseRef: "main",
      testCases: [{
        name: "unit",
        command: "node",
        args: ["--test"],
        cwd: ".",
        timeoutMs: 60_000,
      }],
    });
    const pullRequest = await service.submitPullRequest({
      repository: "LUDIARS/Product",
      title: "Add product feature",
      author: "neco",
      headRef: "feat/local",
    });
    store.updatePullRequest(pullRequest.id, { status: "merged" });
    await assert.rejects(
      () => service.retryPullRequest(pullRequest.id),
      /Only an open local PR can be reviewed again/,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

async function registeredService(fixture, store) {
  const service = new LocalPrService({
    store,
    queue: { async submit() { return { id: "job-1" }; } },
    installGuard: async () => join(fixture.repoPath, ".git", "hooks", "pre-push"),
  });
  await service.registerRepository({
    repository: "LUDIARS/Product",
    rootPath: fixture.repoPath,
    baseRef: "main",
    testCases: [{
      name: "unit",
      command: "node",
      args: ["--test"],
      cwd: ".",
      timeoutMs: 60_000,
    }],
  });
  return service;
}

function submission() {
  return {
    repository: "LUDIARS/Product",
    title: "Add product feature",
    body: "",
    author: "neco",
    headRef: "feat/local",
  };
}

async function readyToMerge(fixture, store) {
  const service = await registeredService(fixture, store);
  const pullRequest = await service.submitPullRequest(submission());
  store.updatePullRequest(pullRequest.id, {
    checkStatus: "test_ok",
    reviewedHeadSha: git(fixture.repoPath, "rev-parse", "feat/local"),
  });
  return { service, pullRequest };
}

test("submits while untracked files sit in the head worktree", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  try {
    const service = await registeredService(fixture, store);
    git(fixture.repoPath, "checkout", "feat/local");
    writeFileSync(join(fixture.repoPath, "local-notes.txt"), "scratch\n", "utf8");
    const pullRequest = await service.submitPullRequest(submission());
    assert.equal(
      pullRequest.headSha,
      git(fixture.repoPath, "rev-parse", "feat/local"),
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("refuses to submit a head worktree carrying tracked modifications", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  try {
    const service = await registeredService(fixture, store);
    git(fixture.repoPath, "checkout", "feat/local");
    writeFileSync(join(fixture.repoPath, "product.txt"), "base\nfeature\nlocal edit\n", "utf8");
    await assert.rejects(
      () => service.submitPullRequest(submission()),
      /head branch worktree has uncommitted changes/,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("merges while untracked files sit in the base worktree", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  try {
    const { service, pullRequest } = await readyToMerge(fixture, store);
    writeFileSync(join(fixture.repoPath, "local-notes.txt"), "scratch\n", "utf8");
    const merged = await service.mergePullRequest(pullRequest.id);
    assert.equal(merged.status, "merged");
    assert.equal(git(fixture.repoPath, "rev-list", "--count", "main"), "2");
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("refuses to advance a base branch carrying tracked modifications", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  try {
    const { service, pullRequest } = await readyToMerge(fixture, store);
    writeFileSync(join(fixture.repoPath, "product.txt"), "base\nlocal edit\n", "utf8");
    await assert.rejects(
      () => service.mergePullRequest(pullRequest.id),
      /worktree is no longer clean/,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
