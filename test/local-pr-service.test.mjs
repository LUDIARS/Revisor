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
import { MergeConflictError, StaleReviewError } from "../src/errors.mjs";
import { LocalPrReporter } from "../src/local-reporter.mjs";
import { LocalPrService } from "../src/local-pr-service.mjs";
import { resolveMergeRepositoryPath } from "../src/merge-repository.mjs";
import { PrReviewQueue } from "../src/queue.mjs";
import { LocalPrStore } from "../src/state-store.mjs";
import { GENIUS_HUMAN_DECISION_REASON } from "../src/human-decision.mjs";

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

function initRepository(path) {
  const init = spawnSync("git", ["init", path], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (init.status !== 0) throw new Error(init.stderr || init.stdout);
  git(path, "checkout", "-b", "main");
  git(path, "config", "user.name", "Test");
  git(path, "config", "user.email", "test@example.invalid");
}

function repositoryFixture() {
  const directory = mkdtempSync(join(tmpdir(), "revisor-local-pr-"));
  const repoPath = join(directory, "Product");
  initRepository(repoPath);
  writeFileSync(join(repoPath, "product.txt"), "base\n", "utf8");
  writeFileSync(join(repoPath, ".revisor-version"), "0.1.0\n", "utf8");
  git(repoPath, "add", "product.txt", ".revisor-version");
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

function passingSecurityScan() {
  return async () => ({
    status: "passed",
    reason: null,
    failOnSeverity: "high",
    totalFindings: 0,
    findings: [],
  });
}

function passingPublisher() {
  return async ({ mergeCommitSha }) => ({
    mergeCommitSha,
    releaseTag: "v0.1.0",
    releaseUrl: "https://github.com/LUDIARS/Product/releases/tag/v0.1.0",
  });
}

test("registers tests, queues a local-only PR, and squash merges it", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  let queued;
  const lifecycle = [];
  const service = new LocalPrService({
    store,
    queue: {
      async submit(request) {
        queued = request;
        return { id: "job-1" };
      },
    },
    installGuard: async () => join(fixture.repoPath, ".git", "hooks", "pre-push"),
    securityScan: passingSecurityScan(),
    publisher: passingPublisher(),
    notifyLifecycle: async (event, pullRequest) => {
      lifecycle.push([event, pullRequest.status]);
    },
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
    const mergeRoot = resolveMergeRepositoryPath({
      repository: { repository: "LUDIARS/Product" },
      statePath: store.path,
    });
    assert.equal(merged.status, "merged");
    assert.equal(merged.releaseTag, "v0.1.0");
    assert.equal(git(mergeRoot, "show", "main:product.txt").replace(/\r\n/g, "\n"), "base\nfeature");
    assert.equal(
      readFileSync(join(fixture.repoPath, "product.txt"), "utf8").replace(/\r\n/g, "\n"),
      "base\n",
    );
    assert.equal(git(fixture.repoPath, "rev-list", "--count", "main"), "1");
    assert.equal(git(mergeRoot, "rev-list", "--count", "main"), "2");
    assert.equal(git(mergeRoot, "log", "-1", "--format=%P", "main"), fixture.baseSha);
    // The merge repository deliberately keeps no branch checked out, so HEAD is
    // still the base commit. Name the branch that the merge advanced.
    assert.match(git(mergeRoot, "log", "-1", "--format=%B", "main"), /Revisor-Local-PR/);
    assert.deepEqual(lifecycle, [
      ["created", "open"],
      ["merged", "merged"],
    ]);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("an explicit merge acknowledges the sole Genius human-decision hold", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  try {
    const service = await registeredService(fixture, store);
    const pullRequest = await service.submitPullRequest({
      repository: "LUDIARS/Product",
      title: "Genius-reviewed change",
      body: "",
      author: "neco",
      headRef: "feat/local",
    });
    store.updatePullRequest(pullRequest.id, {
      checkStatus: "action_required",
      reviewedHeadSha: pullRequest.headSha,
      reviewer: "genius",
      reasons: [GENIUS_HUMAN_DECISION_REASON],
      geniusGuidance: { cards: [{ id: "public-card" }] },
    });

    const merged = await service.mergePullRequest(pullRequest.id);

    assert.equal(merged.status, "merged");
    assert.equal(merged.checkStatus, "test_ok");
    assert.deepEqual(merged.reasons, []);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("an automatic merge never acknowledges the Genius human-decision hold", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  try {
    const service = await registeredService(fixture, store);
    const pullRequest = await service.submitPullRequest({
      repository: "LUDIARS/Product",
      title: "Genius-reviewed change",
      body: "",
      author: "neco",
      headRef: "feat/local",
    });
    store.updatePullRequest(pullRequest.id, {
      checkStatus: "action_required",
      reviewedHeadSha: pullRequest.headSha,
      reviewer: "genius",
      reasons: [GENIUS_HUMAN_DECISION_REASON],
      geniusGuidance: { cards: [{ id: "public-card" }] },
    });

    await assert.rejects(
      () => service.mergePullRequest(pullRequest.id, { humanApproved: false }),
      /Only an Open \/ Test OK local PR can be squash merged/,
    );
    assert.equal(store.getPullRequest(pullRequest.id).status, "open");
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("a Genius decision cannot acknowledge an additional merge blocker", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  try {
    const service = await registeredService(fixture, store);
    const pullRequest = await service.submitPullRequest({
      repository: "LUDIARS/Product",
      title: "Still blocked change",
      body: "",
      author: "neco",
      headRef: "feat/local",
    });
    store.updatePullRequest(pullRequest.id, {
      checkStatus: "action_required",
      reviewedHeadSha: pullRequest.headSha,
      reviewer: "genius",
      reasons: [GENIUS_HUMAN_DECISION_REASON, "registered tests failed"],
      geniusGuidance: { cards: [{ id: "public-card" }] },
    });

    await assert.rejects(
      () => service.mergePullRequest(pullRequest.id),
      /Only an Open \/ Test OK local PR can be squash merged/,
    );
    assert.equal(store.getPullRequest(pullRequest.id).status, "open");
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("re-queues a reviewed local PR against a moved head with a full intent review", async () => {
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
      checkStatus: "action_required",
      reviewedHeadSha: pullRequest.headSha,
      intentReviewCompleted: true,
      reviewer: "codex-sol",
      reasons: ["1 changed architecture rule violation(s) remain"],
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
    assert.equal(submitted[1].reviewMode, "full");
    assert.deepEqual(submitted[1].verificationTargets, []);
    assert.equal(submitted[1].previousReview, null);
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
    runs.push(request);
    await new Promise((resolve) => releases.push(resolve));
    return {
      conclusion: "action_required",
      reviewedHeadSha: request.headSha,
      intentReviewCompleted: true,
      reviewer: "codex-sol",
      ci: [{ name: "unit", status: "failed", exitCode: 1, durationMs: 12 }],
      reasons: ["1 registered test case(s) failed"],
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
    assert.deepEqual(runs.map((request) => request.headSha), [submitted.headSha, submitted.headSha]);
    assert.equal(runs[1].reviewMode, "verification");
    assert.deepEqual(runs[1].verificationTargets, ["tests"]);
    assert.equal(runs[1].previousReview.reviewedHeadSha, submitted.headSha);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

// 追い越された job の終局イベントは、その PR の現在の状態にも通知にも触らない。
// これが漏れると、古いヘッドの結果が現在の審査を上書きし、auto-merge sweep が
// 60 秒ごとに同じ再審査を積み直す無限ループの起点になる。
test("a superseded job neither overwrites nor announces the current review", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  const runs = [];
  const releases = [];
  const announced = [];
  let supersededHead = null;
  const queue = new PrReviewQueue(async (request) => {
    runs.push(request);
    await new Promise((resolve) => releases.push(resolve));
    if (request.headSha === supersededHead) {
      throw new Error(`head SHA changed before review (expected ${supersededHead})`);
    }
    return {
      conclusion: "success",
      reviewedHeadSha: request.headSha,
      intentReviewCompleted: true,
      reviewer: "codex-sol",
      ci: [],
    };
  }, {
    concurrency: 1,
    reporter: new LocalPrReporter(store, {
      notifyCompletion: (pullRequest) => { announced.push(pullRequest.checkStatus); },
    }),
  });
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
      testCases: [],
    });
    const submitted = await service.submitPullRequest({
      repository: "LUDIARS/Product",
      title: "Add product feature",
      author: "neco",
      headRef: "feat/local",
    });
    supersededHead = submitted.headSha;

    // 最初の job を走らせたまま、ブランチを進めて再投入する。
    await waitForCheckStatus(store, submitted.id, "running");
    git(fixture.repoPath, "checkout", "feat/local");
    writeFileSync(join(fixture.repoPath, "extra.txt"), "feature three\n", "utf8");
    git(fixture.repoPath, "add", "extra.txt");
    git(fixture.repoPath, "commit", "-m", "feature three");
    git(fixture.repoPath, "checkout", "main");
    const movedHead = git(fixture.repoPath, "rev-parse", "feat/local");
    const retried = await service.retryPullRequest(submitted.id);
    assert.equal(retried.headSha, movedHead);

    // 追い越された job をここで失敗させる。 現在の審査 (moved head) は無傷でなければならない。
    await releaseRun(releases);
    for (let attempt = 0; attempt < 200 && runs.length < 2; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(runs.length, 2);
    assert.equal(runs[1].headSha, movedHead);
    const current = store.getPullRequest(submitted.id);
    assert.notEqual(current.checkStatus, "failed");
    assert.equal(current.error, null);
    assert.equal(current.headSha, movedHead);
    assert.deepEqual(announced, []);

    // 置き換えた job の結果だけが PR の判定になる。
    await releaseRun(releases);
    const settled = await waitForCheckStatus(store, submitted.id, "test_ok");
    assert.equal(settled.reviewedHeadSha, movedHead);
    assert.deepEqual(announced, ["test_ok"]);
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

async function registeredService(fixture, store, securityScan = passingSecurityScan()) {
  const service = new LocalPrService({
    store,
    queue: { async submit() { return { id: "job-1" }; } },
    installGuard: async () => join(fixture.repoPath, ".git", "hooks", "pre-push"),
    securityScan,
    publisher: passingPublisher(),
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

async function readyToMerge(fixture, store, securityScan = passingSecurityScan()) {
  const service = await registeredService(fixture, store, securityScan);
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

test("adopts the session of a resubmission that joins an in-flight review", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  try {
    const service = await registeredService(fixture, store);
    const first = await service.submitPullRequest(submission());
    assert.equal(first.sessionId, null);
    // 同じ head の再投稿は既存レビューに相乗りする。 宛先を拾わないと、投げ直した
    // セッションは来ない完了通知を待ち続ける。
    const second = await service.submitPullRequest({
      ...submission(),
      sessionId: "lictor-abc",
      sourceLinks: [{
        platform: "discord",
        label: "Discord セッション投稿",
        url: "https://discord.com/channels/1/2/3",
      }],
    });
    assert.equal(second.id, first.id);
    assert.equal(second.sessionId, "lictor-abc");
    assert.equal(second.sourceLinks.length, 1);
    assert.match(second.body, /discord\.com\/channels\/1\/2\/3/);
    // 既に宛先がある相乗りは奪わない (1 レビュー 1 通)。
    const third = await service.submitPullRequest({
      ...submission(),
      sessionId: "lictor-xyz",
      sourceLinks: [{
        platform: "slack",
        label: "Slack セッション投稿",
        url: "https://workspace.slack.com/archives/C1/p123",
      }],
    });
    assert.equal(third.sessionId, "lictor-abc");
    assert.equal(third.sourceLinks.length, 2);
    assert.match(third.body, /workspace\.slack\.com\/archives\/C1\/p123/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("stores source links and adds them to the PR description", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  try {
    const service = await registeredService(fixture, store);
    const pullRequest = await service.submitPullRequest({
      ...submission(),
      body: "Original description",
      sourceLinks: [{
        platform: "discord",
        label: "Discord セッション投稿",
        url: "https://discord.com/channels/1/2/3",
      }],
    });
    assert.deepEqual(pullRequest.sourceLinks, [{
      platform: "discord",
      label: "Discord セッション投稿",
      url: "https://discord.com/channels/1/2/3",
    }]);
    assert.match(pullRequest.body, /関連メッセージ:[\s\S]*discord\.com\/channels\/1\/2\/3/);
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
    assert.equal(git(fixture.repoPath, "rev-list", "--count", "main"), "1");
    assert.equal(readFileSync(join(fixture.repoPath, "local-notes.txt"), "utf8"), "scratch\n");
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("blocks the squash merge on pre-merge security findings", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  const scanned = [];
  try {
    const { service, pullRequest } = await readyToMerge(fixture, store, async (target) => {
      scanned.push(target);
      return {
        status: "findings",
        reason: null,
        failOnSeverity: "high",
        totalFindings: 2,
        findings: [],
      };
    });
    await assert.rejects(
      () => service.mergePullRequest(pullRequest.id),
      /Merge blocked: 2 security finding\(s\) at or above 'high'/,
    );
    assert.equal(scanned.length, 1);
    assert.equal(scanned[0].diffBase, fixture.baseSha);
    assert.equal(git(fixture.repoPath, "rev-parse", "main"), fixture.baseSha);
    assert.equal(store.getPullRequest(pullRequest.id).status, "open");
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("blocks the squash merge when the pre-merge security scan is incomplete", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  try {
    const { service, pullRequest } = await readyToMerge(fixture, store, async () => ({
      status: "error",
      reason: "codex-security exited with code 2",
      failOnSeverity: "high",
      totalFindings: 0,
      findings: [],
    }));
    await assert.rejects(
      () => service.mergePullRequest(pullRequest.id),
      /pre-merge security scan did not complete/,
    );
    assert.equal(git(fixture.repoPath, "rev-parse", "main"), fixture.baseSha);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("blocks the squash merge when the pre-merge scan returns no usable result", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  try {
    const { service, pullRequest } = await readyToMerge(fixture, store, async () => undefined);
    await assert.rejects(
      () => service.mergePullRequest(pullRequest.id),
      /produced no usable result/,
    );
    assert.equal(git(fixture.repoPath, "rev-parse", "main"), fixture.baseSha);
    assert.equal(store.getPullRequest(pullRequest.id).status, "open");
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("merges without touching tracked modifications in the source base checkout", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  try {
    const { service, pullRequest } = await readyToMerge(fixture, store);
    writeFileSync(join(fixture.repoPath, "product.txt"), "base\nlocal edit\n", "utf8");
    const before = git(fixture.repoPath, "status", "--porcelain");
    const merged = await service.mergePullRequest(pullRequest.id);
    assert.equal(merged.status, "merged");
    assert.equal(git(fixture.repoPath, "status", "--porcelain"), before);
    assert.equal(readFileSync(join(fixture.repoPath, "product.txt"), "utf8"), "base\nlocal edit\n");
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

// Adding the submodule moves 'main' on, so 'feat/local' is rebased back onto it
// and the recorded base SHA is refreshed; the spread would otherwise hand tests
// the pre-submodule base.
function submoduleFixture() {
  const fixture = repositoryFixture();
  const modulePath = join(fixture.directory, "Module");
  initRepository(modulePath);
  writeFileSync(join(modulePath, "shared.txt"), "shared\n", "utf8");
  git(modulePath, "add", "shared.txt");
  git(modulePath, "commit", "-m", "shared base");
  git(
    fixture.repoPath,
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    modulePath.replace(/\\/g, "/"),
    "lib/module",
  );
  git(fixture.repoPath, "commit", "-m", "add submodule");
  git(fixture.repoPath, "checkout", "feat/local");
  git(fixture.repoPath, "rebase", "main");
  git(fixture.repoPath, "checkout", "main");
  return {
    ...fixture,
    baseSha: git(fixture.repoPath, "rev-parse", "main"),
    modulePath,
  };
}

test("merges while a submodule carries its own uncommitted content", async () => {
  const fixture = submoduleFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  try {
    const { service, pullRequest } = await readyToMerge(fixture, store);
    writeFileSync(join(fixture.repoPath, "lib", "module", "shared.txt"), "edited\n", "utf8");
    assert.match(
      git(fixture.repoPath, "status", "--porcelain", "--untracked-files=no"),
      /lib\/module/,
    );
    const merged = await service.mergePullRequest(pullRequest.id);
    assert.equal(merged.status, "merged");
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("merges without touching an uncommitted submodule pointer in the source checkout", async () => {
  const fixture = submoduleFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  try {
    const { service, pullRequest } = await readyToMerge(fixture, store);
    writeFileSync(join(fixture.modulePath, "shared.txt"), "next\n", "utf8");
    git(fixture.modulePath, "add", "shared.txt");
    git(fixture.modulePath, "commit", "-m", "shared next");
    const submodulePath = join(fixture.repoPath, "lib", "module");
    git(submodulePath, "-c", "protocol.file.allow=always", "fetch", "origin");
    git(submodulePath, "checkout", git(fixture.modulePath, "rev-parse", "HEAD"));
    const before = git(fixture.repoPath, "status", "--porcelain", "--untracked-files=no");
    const merged = await service.mergePullRequest(pullRequest.id);
    assert.equal(merged.status, "merged");
    assert.equal(
      git(fixture.repoPath, "status", "--porcelain", "--untracked-files=no"),
      before,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

// ─── 中断されたレビューの復旧 (プロセス再起動でゾンビ化した job) ──────────────
//
// キューは in-memory なので、 起動直後に残っている `queued` / `running` は
// どのワーカーにも属していない = 中断された job。 これを拾い直さないと
// queue.submit の再投入ガードに弾かれ続けて永久に動かない。

/** state.json を直接書き換えて「前回のプロセスが落ちた」状態を作る。 */
function forceCheckStatus(store, id, checkStatus) {
  const statePath = store.path;
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const record = state.pullRequests.find((candidate) => candidate.id === id);
  assert.ok(record, `Local PR '${id}' is missing from the state file.`);
  record.checkStatus = checkStatus;
  writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

async function submittedPullRequest(fixture, store, submissions, options = {}) {
  const service = new LocalPrService({
    store,
    queue: {
      async submit(request, submitOptions) {
        submissions.push({ request, options: submitOptions });
        if (options.failSubmitAfter !== undefined && submissions.length > options.failSubmitAfter) {
          throw new Error("queue is closed");
        }
        return { id: `job-${submissions.length}` };
      },
    },
    installGuard: async () => join(fixture.repoPath, ".git", "hooks", "pre-push"),
    securityScan: passingSecurityScan(),
    ...(options.notifyLifecycle ? { notifyLifecycle: options.notifyLifecycle } : {}),
  });
  await service.registerRepository({
    repository: "LUDIARS/Product",
    rootPath: fixture.repoPath,
    baseRef: "main",
    testCases: [{ name: "unit", command: "node", args: ["--test"], cwd: ".", timeoutMs: 60_000 }],
  });
  const pullRequest = await service.submitPullRequest({
    repository: "LUDIARS/Product",
    title: "Add product feature",
    body: "body",
    author: "neco",
    headRef: "feat/local",
  });
  return { service, pullRequest };
}

test("re-queues reviews left running by a crashed process", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  const submissions = [];
  try {
    const { service, pullRequest } = await submittedPullRequest(fixture, store, submissions);
    forceCheckStatus(store, pullRequest.id, "running");

    const recovery = await service.recoverInterruptedReviews();

    assert.equal(recovery.scanned, 1);
    assert.equal(recovery.recovered.length, 1);
    assert.equal(recovery.failed.length, 0);
    assert.equal(store.getPullRequest(pullRequest.id).checkStatus, "queued");
    // 再投入は force 必須 (同一 head の settled job にフォールバックさせない)。
    assert.equal(submissions.at(-1).options?.force, true);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("re-queues reviews still marked queued after a restart", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  const submissions = [];
  try {
    const { service, pullRequest } = await submittedPullRequest(fixture, store, submissions);
    forceCheckStatus(store, pullRequest.id, "queued");

    const recovery = await service.recoverInterruptedReviews();

    assert.equal(recovery.recovered.length, 1);
    assert.equal(store.getPullRequest(pullRequest.id).checkStatus, "queued");
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("leaves settled reviews untouched during recovery", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  const submissions = [];
  try {
    const { service, pullRequest } = await submittedPullRequest(fixture, store, submissions);
    forceCheckStatus(store, pullRequest.id, "test_ok");
    const before = submissions.length;

    const recovery = await service.recoverInterruptedReviews();

    assert.equal(recovery.scanned, 0);
    assert.equal(submissions.length, before);
    assert.equal(store.getPullRequest(pullRequest.id).checkStatus, "test_ok");
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("announces an unresumable review once, with the restart reason", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  const submissions = [];
  const lifecycle = [];
  try {
    // 最初の投稿は通し、復旧時の再投入だけ落とす: #enqueue と復旧処理の両方が
    // 通知を出すと、同じ PR について理由の違う 2 通が報告 channel に並ぶ。
    const { service, pullRequest } = await submittedPullRequest(fixture, store, submissions, {
      failSubmitAfter: 1,
      notifyLifecycle: (event, record) => {
        lifecycle.push([event, record.error]);
      },
    });
    forceCheckStatus(store, pullRequest.id, "running");

    const recovery = await service.recoverInterruptedReviews();

    assert.equal(recovery.failed.length, 1);
    assert.deepEqual(lifecycle.map(([event]) => event), ["created", "review_failed"]);
    assert.match(lifecycle.at(-1)[1], /Revisor restarted while this review was in flight/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("fails an interrupted review that can no longer be resumed", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  const submissions = [];
  try {
    const { service, pullRequest } = await submittedPullRequest(fixture, store, submissions);
    forceCheckStatus(store, pullRequest.id, "running");
    // head ブランチが消えると refs 再解決に失敗する。
    git(fixture.repoPath, "branch", "-D", "feat/local");

    const recovery = await service.recoverInterruptedReviews();

    assert.equal(recovery.recovered.length, 0);
    assert.equal(recovery.failed.length, 1);
    const settled = store.getPullRequest(pullRequest.id);
    // ゾンビのまま残さず、必ず終端状態へ落とす。
    assert.equal(settled.checkStatus, "failed");
    assert.match(settled.error, /Revisor restarted while this review was in flight/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("a merge conflict drops the PR to action_required instead of leaving it Test OK", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  const service = new LocalPrService({
    store,
    queue: { async submit() { return { id: "job-1" }; } },
    installGuard: async () => join(fixture.repoPath, ".git", "hooks", "pre-push"),
    merge: async () => {
      throw new MergeConflictError("The head conflicts with the current 'main'.");
    },
  });
  try {
    await service.registerRepository({
      repository: "LUDIARS/Product",
      rootPath: fixture.repoPath,
      baseRef: "main",
      testCases: [],
    });
    const pullRequest = await service.submitPullRequest({
      repository: "LUDIARS/Product",
      title: "conflicting", body: "", author: "neco",
      headRef: "feat/local",
    });
    store.updatePullRequest(pullRequest.id, {
      checkStatus: "test_ok",
      reviewedHeadSha: pullRequest.headSha,
    });

    await assert.rejects(service.mergePullRequest(pullRequest.id), MergeConflictError);

    const after = store.getPullRequest(pullRequest.id);
    assert.equal(after.status, "open");
    assert.equal(after.checkStatus, "action_required");
    assert.match(after.reasons.join(" "), /conflicts/);
    // Test OK から外れたので Test Forum の候補にも載らない。
    assert.deepEqual(store.testWorkflowProducts(), []);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("a stale review is re-queued automatically on merge", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  const submissions = [];
  const service = new LocalPrService({
    store,
    queue: {
      async submit(request, options) {
        submissions.push({ request, options });
        return { id: `job-${submissions.length}` };
      },
    },
    installGuard: async () => join(fixture.repoPath, ".git", "hooks", "pre-push"),
    merge: async () => {
      throw new StaleReviewError("The head content changed after the review.");
    },
  });
  try {
    await service.registerRepository({
      repository: "LUDIARS/Product",
      rootPath: fixture.repoPath,
      baseRef: "main",
      testCases: [],
    });
    const pullRequest = await service.submitPullRequest({
      repository: "LUDIARS/Product",
      title: "stale", body: "", author: "neco",
      headRef: "feat/local",
    });
    store.updatePullRequest(pullRequest.id, {
      checkStatus: "test_ok",
      reviewedHeadSha: pullRequest.headSha,
    });

    await assert.rejects(service.mergePullRequest(pullRequest.id), StaleReviewError);

    const after = store.getPullRequest(pullRequest.id);
    assert.equal(after.status, "open");
    assert.equal(after.checkStatus, "queued");
    // A legacy/custom merge can omit StaleReviewError.headSha. The limiter must
    // still scope that retry to this PR head instead of a shared "unknown" key.
    assert.deepEqual(after.staleReviewRequeue, {
      headSha: pullRequest.headSha.toLowerCase(),
      count: 1,
    });
    // 再審査は同一 head でも走るよう force 付きで投入される。
    assert.equal(submissions.length, 2);
    assert.deepEqual(submissions[1].options, { force: true });
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

// 同じヘッドで stale が返り続けるなら再審査では解けない。 スイープが 60 秒ごとに
// 同じ再審査を積み直さないよう、上限で人間の判断へ渡す。
test("stops re-queueing a head that keeps coming back stale", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  const submissions = [];
  const service = new LocalPrService({
    store,
    queue: {
      async submit(request, options) {
        submissions.push({ request, options });
        return { id: `job-${submissions.length}` };
      },
    },
    installGuard: async () => join(fixture.repoPath, ".git", "hooks", "pre-push"),
    merge: async ({ pullRequest }) => {
      throw new StaleReviewError("The head content changed after the review.", {
        headSha: pullRequest.headSha,
      });
    },
  });
  try {
    await service.registerRepository({
      repository: "LUDIARS/Product",
      rootPath: fixture.repoPath,
      baseRef: "main",
      testCases: [],
    });
    const pullRequest = await service.submitPullRequest({
      repository: "LUDIARS/Product",
      title: "stale", body: "", author: "neco",
      headRef: "feat/local",
    });
    const restore = () => store.updatePullRequest(pullRequest.id, {
      checkStatus: "test_ok",
      reviewedHeadSha: pullRequest.headSha,
    });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      restore();
      await assert.rejects(service.mergePullRequest(pullRequest.id), StaleReviewError);
      assert.equal(store.getPullRequest(pullRequest.id).checkStatus, "queued");
    }
    const requeued = submissions.length;

    restore();
    await assert.rejects(service.mergePullRequest(pullRequest.id), StaleReviewError);
    const held = store.getPullRequest(pullRequest.id);
    assert.equal(held.checkStatus, "action_required");
    assert.equal(submissions.length, requeued, "the bounded PR must not be re-queued again");
    assert.match(held.reasons.join(" "), /自動再審査を停止/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

// サービス停止中に最小限の対応を通すための CLI 限定経路。 通した事実が記録に残らなければ
// 後追いレビューの対象を特定できないので、印と理由は必須にする。
test("a bypass merge lands without a review and is marked for follow-up", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  const seen = [];
  const service = new LocalPrService({
    store,
    queue: { async submit() { return { id: "job-1" }; } },
    installGuard: async () => join(fixture.repoPath, ".git", "hooks", "pre-push"),
    merge: async (input) => {
      seen.push(input);
      return { mergeCommitSha: "0123456789abcdef0123" };
    },
  });
  try {
    await service.registerRepository({
      repository: "LUDIARS/Product",
      rootPath: fixture.repoPath,
      baseRef: "main",
      testCases: [],
    });
    const pullRequest = await service.submitPullRequest({
      repository: "LUDIARS/Product",
      title: "restore the merge path", body: "", author: "neco",
      headRef: "feat/local",
    });
    // 審査は一度も通っていない。 通常経路ならここで止まる状態。
    assert.equal(store.getPullRequest(pullRequest.id).checkStatus, "queued");

    await assert.rejects(
      service.mergePullRequest(pullRequest.id, { bypass: { reason: "  " } }),
      /bypass merge requires a reason/,
    );

    const merged = await service.mergePullRequest(pullRequest.id, {
      bypass: { reason: "Revisor 自身が停止しており審査を回せない", actor: "cli" },
    });
    assert.equal(merged.status, "merged");
    assert.equal(seen[0].bypass.reason, "Revisor 自身が停止しており審査を回せない");
    assert.equal(merged.bypassMerge.checkStatusAtMerge, "queued");
    assert.equal(merged.bypassMerge.reviewedAfterRecovery, false);
    assert.equal(merged.bypassMerge.actor, "cli");
    assert.match(merged.bypassMerge.reason, /審査を回せない/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("an ordinary merge carries no bypass mark", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  const service = new LocalPrService({
    store,
    queue: { async submit() { return { id: "job-1" }; } },
    installGuard: async () => join(fixture.repoPath, ".git", "hooks", "pre-push"),
    merge: async () => ({ mergeCommitSha: "0123456789abcdef0123" }),
  });
  try {
    await service.registerRepository({
      repository: "LUDIARS/Product",
      rootPath: fixture.repoPath,
      baseRef: "main",
      testCases: [],
    });
    const pullRequest = await service.submitPullRequest({
      repository: "LUDIARS/Product",
      title: "ordinary", body: "", author: "neco",
      headRef: "feat/local",
    });
    store.updatePullRequest(pullRequest.id, {
      checkStatus: "test_ok",
      reviewedHeadSha: pullRequest.headSha,
    });
    const merged = await service.mergePullRequest(pullRequest.id);
    assert.equal(merged.bypassMerge, undefined);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("the auto-merge sweep ignores legacy draft metadata", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  const mergedIds = [];
  const service = new LocalPrService({
    store,
    queue: { async submit() { return { id: "job-1" }; } },
    installGuard: async () => join(fixture.repoPath, ".git", "hooks", "pre-push"),
    merge: async ({ pullRequest }) => {
      mergedIds.push(pullRequest.id);
      return "f".repeat(40);
    },
    loadSettings: () => ({
      autoMergeEnabled: true,
      autoMergeRiskThreshold: 15,
      autoMergeRequiresRuntimeVerificationClear: true,
    }),
  });
  try {
    await service.registerRepository({
      repository: "LUDIARS/Product",
      rootPath: fixture.repoPath,
      baseRef: "main",
      testCases: [],
    });
    const eligible = await service.submitPullRequest({
      repository: "LUDIARS/Product",
      title: "eligible", body: "", author: "neco",
      headRef: "feat/local",
    });
    store.updatePullRequest(eligible.id, {
      checkStatus: "test_ok",
      reviewedHeadSha: eligible.headSha,
      mergeRisk: { score: 5, factors: [] },
      reasons: [],
    });
    // 同一 head の再投稿は既存 PR に相乗りするので、legacy PR には別ブランチを使う。
    git(fixture.repoPath, "checkout", "-b", "feat/draft", "feat/local");
    writeFileSync(join(fixture.repoPath, "draft.txt"), "draft\n", "utf8");
    git(fixture.repoPath, "add", "draft.txt");
    git(fixture.repoPath, "commit", "-m", "draft work");
    git(fixture.repoPath, "checkout", "main");
    const draft = await service.submitPullRequest({
      repository: "LUDIARS/Product",
      title: "draft", body: "", author: "neco",
      headRef: "feat/draft",
      draft: true,
    });
    store.updatePullRequest(draft.id, {
      draft: true,
      checkStatus: "test_ok",
      reviewedHeadSha: draft.headSha,
      mergeRisk: { score: 5, factors: [] },
      reasons: [],
    });

    const summary = await service.sweepAutoMerge();

    assert.deepEqual(summary, { attempted: 2, merged: 2, failed: 0 });
    assert.deepEqual(new Set(mergedIds), new Set([eligible.id, draft.id]));
    const after = store.getPullRequest(eligible.id);
    assert.equal(after.status, "merged");
    assert.equal(after.autoMerge.merged, true);
    assert.equal(store.getPullRequest(draft.id).status, "merged");
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

// スイープは 60 秒間隔のタイマーで回る一方、1 周はマージ前セキュリティスキャン次第で
// それより長くなる。 重なった周回とレビュー完了時の自動マージが同じ PR を二度
// マージしにいくと、2 本目は必ず「base が動いた」で落ちて、マージ可能な PR が失敗
// 記録付きで残る。 squash は起点が何であれ 1 本ずつしか走らない。
test("a sweep and a review-completion auto-merge never squash the same PR at once", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  const mergedIds = [];
  let inFlight = 0;
  let concurrent = 0;
  let releaseMerge;
  const mergeStarted = new Promise((resolve) => {
    releaseMerge = resolve;
  });
  const service = new LocalPrService({
    store,
    queue: { async submit() { return { id: "job-1" }; } },
    installGuard: async () => join(fixture.repoPath, ".git", "hooks", "pre-push"),
    merge: async ({ pullRequest }) => {
      // 本物の squash と同じ前提条件。 直列化されていれば、2 本目が回るころには
      // PR は merged になっていて、ここで弾かれる。
      if (pullRequest.status !== "open" || pullRequest.checkStatus !== "test_ok") {
        throw new Error("Only an Open / Test OK local PR can be squash merged.");
      }
      inFlight += 1;
      concurrent = Math.max(concurrent, inFlight);
      releaseMerge();
      await new Promise((settle) => setTimeout(settle, 20));
      inFlight -= 1;
      mergedIds.push(pullRequest.id);
      return "f".repeat(40);
    },
    loadSettings: () => ({
      autoMergeEnabled: true,
      autoMergeRiskThreshold: 15,
      autoMergeRequiresRuntimeVerificationClear: true,
    }),
  });
  try {
    await service.registerRepository({
      repository: "LUDIARS/Product",
      rootPath: fixture.repoPath,
      baseRef: "main",
      testCases: [],
    });
    const eligible = await service.submitPullRequest({
      repository: "LUDIARS/Product",
      title: "eligible", body: "", author: "neco",
      headRef: "feat/local",
    });
    store.updatePullRequest(eligible.id, {
      checkStatus: "test_ok",
      reviewedHeadSha: eligible.headSha,
      mergeRisk: { score: 5, factors: [] },
      reasons: [],
    });

    const sweep = service.sweepAutoMerge();
    // 1 周目がマージの最中にいるあいだに、2 周目のタイマーとレビュー完了時の
    // 自動マージが同じ PR に重なる。
    await mergeStarted;
    const overlappingSweep = await service.sweepAutoMerge();
    const overlappingCompletion = service.autoMergeIfEligible(eligible.id);
    const summary = await sweep;
    await overlappingCompletion;

    assert.deepEqual(summary, { attempted: 1, merged: 1, failed: 0 });
    // 周回は重ならない。
    assert.deepEqual(overlappingSweep, { attempted: 0, merged: 0, failed: 0 });
    // 起点が違っても squash が同時に 2 本走ることはなく、実際に走ったのは 1 本だけ。
    assert.equal(concurrent, 1);
    assert.deepEqual(mergedIds, [eligible.id]);
    assert.equal(store.getPullRequest(eligible.id).status, "merged");
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

// 候補一覧は周回開始時のスナップショット。 その間に手動マージやレビュー完了時の
// 自動マージが同じ PR を終わらせていたら、スイープは触らずに見送る。
test("the sweep re-reads each candidate and skips one merged mid-sweep", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  const mergedIds = [];
  const service = new LocalPrService({
    store,
    queue: { async submit() { return { id: "job-1" }; } },
    installGuard: async () => join(fixture.repoPath, ".git", "hooks", "pre-push"),
    merge: async ({ pullRequest }) => {
      mergedIds.push(pullRequest.id);
      // 1 件目のマージ中に、残りの候補が別経路でマージ済みになる。
      for (const candidate of store.listPullRequests()) {
        if (candidate.id !== pullRequest.id && candidate.status === "open") {
          store.updatePullRequest(candidate.id, {
            status: "merged",
            mergeCommitSha: "e".repeat(40),
          });
        }
      }
      return "f".repeat(40);
    },
    loadSettings: () => ({
      autoMergeEnabled: true,
      autoMergeRiskThreshold: 15,
      autoMergeRequiresRuntimeVerificationClear: true,
    }),
  });
  try {
    await service.registerRepository({
      repository: "LUDIARS/Product",
      rootPath: fixture.repoPath,
      baseRef: "main",
      testCases: [],
    });
    git(fixture.repoPath, "checkout", "-b", "feat/second", "feat/local");
    writeFileSync(join(fixture.repoPath, "second.txt"), "second\n", "utf8");
    git(fixture.repoPath, "add", "second.txt");
    git(fixture.repoPath, "commit", "-m", "second work");
    git(fixture.repoPath, "checkout", "main");
    const ids = [];
    for (const headRef of ["feat/local", "feat/second"]) {
      const pullRequest = await service.submitPullRequest({
        repository: "LUDIARS/Product",
        title: headRef, body: "", author: "neco",
        headRef,
      });
      store.updatePullRequest(pullRequest.id, {
        checkStatus: "test_ok",
        reviewedHeadSha: pullRequest.headSha,
        mergeRisk: { score: 5, factors: [] },
        reasons: [],
      });
      ids.push(pullRequest.id);
    }

    const summary = await service.sweepAutoMerge();

    assert.deepEqual(summary, { attempted: 1, merged: 1, failed: 0 });
    assert.equal(mergedIds.length, 1);
    assert.ok(ids.includes(mergedIds[0]));
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("closes an open local PR and keeps it out of the test workflow", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  const announced = [];
  const service = new LocalPrService({
    store,
    queue: { async submit() { return { id: "job-1" }; } },
    installGuard: async () => join(fixture.repoPath, ".git", "hooks", "pre-push"),
    notifyLifecycle: async (event, record) => { announced.push({ event, status: record.status }); },
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
    // 審査が終わって test_ok になった PR を、 マージせずに取り下げる。
    store.updatePullRequest(pullRequest.id, { checkStatus: "test_ok" });
    assert.equal(service.testWorkflowProducts().length, 1);

    const closed = await service.closePullRequest(pullRequest.id, { reason: " 別経路で main へ入った " });
    assert.equal(closed.status, "closed");
    assert.equal(closed.closeReason, "別経路で main へ入った");
    assert.ok(closed.closedAt);
    // 取り下げた PR は「テストして」と人間へ出し続けない。
    assert.deepEqual(service.testWorkflowProducts(), []);
    // 通知が無いと、 PR を待っている人と Discord スレッドが開いたまま取り残される。
    assert.deepEqual(announced, [{ event: "created", status: "open" }, { event: "closed", status: "closed" }]);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("a closed local PR can be neither merged, re-queued, nor closed twice", async () => {
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
    store.updatePullRequest(pullRequest.id, { checkStatus: "test_ok" });
    await service.closePullRequest(pullRequest.id);

    await assert.rejects(
      () => service.mergePullRequest(pullRequest.id),
      /Only an open local PR can be merged/,
    );
    await assert.rejects(
      () => service.retryPullRequest(pullRequest.id),
      /Only an open local PR can be reviewed again/,
    );
    await assert.rejects(
      () => service.closePullRequest(pullRequest.id),
      /Only an open local PR can be closed/,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("refuses to close a local PR while its review is in flight", async () => {
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
    // 提出直後は queued。 走っているワーカーが結果を書き戻すので、 ここで closed に
    // しても上書きされて open へ戻ったように見えるだけになる。
    assert.equal(store.getPullRequest(pullRequest.id).checkStatus, "queued");
    await assert.rejects(
      () => service.closePullRequest(pullRequest.id),
      /A local PR under review cannot be closed/,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

// squash はマージ前セキュリティスキャンを含むので数分かかる一方、closePullRequest は
// 同期で status を書く。 走っているマージの最中に取り下げを通すと、 完了した merge が
// status: "merged" を書き戻して取り下げを踏み潰し、 取り下げたはずの変更が board から
// 消えないまま main へ入る。 審査中と同じく、 マージ中の close も拒否する。
test("refuses to close a local PR while its squash merge is in flight", async () => {
  const fixture = repositoryFixture();
  const store = new LocalPrStore({ path: join(fixture.directory, "state.json") });
  let releaseMerge;
  const mergeStarted = new Promise((resolve) => {
    releaseMerge = resolve;
  });
  let finishMerge;
  const mergeBlocked = new Promise((resolve) => {
    finishMerge = resolve;
  });
  const service = new LocalPrService({
    store,
    queue: { async submit() { return { id: "job-1" }; } },
    installGuard: async () => join(fixture.repoPath, ".git", "hooks", "pre-push"),
    merge: async () => {
      releaseMerge();
      await mergeBlocked;
      return "f".repeat(40);
    },
  });
  try {
    await service.registerRepository({
      repository: "LUDIARS/Product",
      rootPath: fixture.repoPath,
      baseRef: "main",
      testCases: [],
    });
    const pullRequest = await service.submitPullRequest({
      repository: "LUDIARS/Product",
      title: "Add product feature",
      author: "neco",
      headRef: "feat/local",
    });
    store.updatePullRequest(pullRequest.id, {
      checkStatus: "test_ok",
      reviewedHeadSha: pullRequest.headSha,
    });

    const merging = service.mergePullRequest(pullRequest.id);
    await mergeStarted;
    await assert.rejects(
      () => service.closePullRequest(pullRequest.id),
      /A local PR being merged cannot be closed/,
    );
    finishMerge();
    await merging;

    // マージは踏み潰されずに記録され、取り下げは通らなかった。
    const after = store.getPullRequest(pullRequest.id);
    assert.equal(after.status, "merged");
    assert.equal(after.closeReason, undefined);
    // マージが終われば締め出しは解ける (終局済みとして拒否される)。
    await assert.rejects(
      () => service.closePullRequest(pullRequest.id),
      /Only an open local PR can be closed/,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
