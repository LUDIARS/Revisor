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

function passingSecurityScan() {
  return async () => ({
    status: "passed",
    reason: null,
    failOnSeverity: "high",
    totalFindings: 0,
    findings: [],
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
    assert.equal(merged.status, "merged");
    assert.equal(
      readFileSync(join(fixture.repoPath, "product.txt"), "utf8").replace(/\r\n/g, "\n"),
      "base\nfeature\n",
    );
    assert.equal(git(fixture.repoPath, "rev-list", "--count", "main"), "2");
    assert.equal(git(fixture.repoPath, "log", "-1", "--format=%P"), fixture.baseSha);
    assert.match(git(fixture.repoPath, "log", "-1", "--format=%B"), /Revisor-Local-PR/);
    assert.deepEqual(lifecycle, [
      ["created", "open"],
      ["merged", "merged"],
    ]);
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

async function registeredService(fixture, store, securityScan = passingSecurityScan()) {
  const service = new LocalPrService({
    store,
    queue: { async submit() { return { id: "job-1" }; } },
    installGuard: async () => join(fixture.repoPath, ".git", "hooks", "pre-push"),
    securityScan,
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
    });
    assert.equal(second.id, first.id);
    assert.equal(second.sessionId, "lictor-abc");
    // 既に宛先がある相乗りは奪わない (1 レビュー 1 通)。
    const third = await service.submitPullRequest({
      ...submission(),
      sessionId: "lictor-xyz",
    });
    assert.equal(third.sessionId, "lictor-abc");
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

test("still blocks when the submodule pointer itself moved", async () => {
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
    await assert.rejects(
      () => service.mergePullRequest(pullRequest.id),
      /worktree is no longer clean/,
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
