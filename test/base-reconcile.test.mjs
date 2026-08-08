import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { reconcileBaseWithRemote } from "../src/base-reconcile.mjs";
import { BaseMovedError, RevisorError } from "../src/errors.mjs";
import { squashMergeLocalPullRequest } from "../src/local-merge.mjs";

function git(repoPath, ...args) {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

// ローカル正本 (main 1 コミット) と、 そこから clone した「GitHub 側」 リポジトリ。
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "revisor-base-reconcile-"));
  const localPath = join(directory, "Local");
  const init = spawnSync("git", ["init", localPath], { encoding: "utf8", windowsHide: true });
  if (init.status !== 0) throw new Error(init.stderr || init.stdout);
  git(localPath, "checkout", "-b", "main");
  git(localPath, "config", "user.name", "Test");
  git(localPath, "config", "user.email", "test@example.invalid");
  writeFileSync(join(localPath, "product.txt"), "base\n", "utf8");
  writeFileSync(join(localPath, "other.txt"), "other\n", "utf8");
  git(localPath, "add", ".");
  git(localPath, "commit", "-m", "base");
  const remotePath = join(directory, "GitHub");
  const clone = spawnSync("git", ["clone", localPath, remotePath], { encoding: "utf8", windowsHide: true });
  if (clone.status !== 0) throw new Error(clone.stderr || clone.stdout);
  git(remotePath, "config", "user.name", "Remote");
  git(remotePath, "config", "user.email", "remote@example.invalid");
  return { directory, localPath, remotePath };
}

// 実 GitHub へは出ない: fetch の URL 引数だけを fixture の「GitHub 側」パスに差し替える。
function localOnlyRemoteGit(remotePath) {
  return async ({ cwd, args }) => {
    const rewritten = args.map((arg) => (arg.startsWith("https://github.com/") ? remotePath : arg));
    return git(cwd, ...rewritten);
  };
}

const stubClient = () => ({ installationToken: async () => "test-token" });

function reconcileInput(localPath, remotePath) {
  return {
    repository: { repository: "LUDIARS/Product", rootPath: localPath, baseRef: "main" },
    baseRef: "main",
    runRemoteGit: localOnlyRemoteGit(remotePath),
    createClient: stubClient,
  };
}

test("reports nothing to do when GitHub is not ahead", async () => {
  const { directory, localPath, remotePath } = fixture();
  try {
    const report = await reconcileBaseWithRemote(reconcileInput(localPath, remotePath));
    assert.equal(report.action, "none");
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10 });
  }
});

test("fast-forwards the local base when only GitHub is ahead", async () => {
  const { directory, localPath, remotePath } = fixture();
  try {
    writeFileSync(join(remotePath, "remote.txt"), "remote\n", "utf8");
    git(remotePath, "add", ".");
    git(remotePath, "commit", "-m", "remote-only change");
    const remoteSha = git(remotePath, "rev-parse", "HEAD");

    const report = await reconcileBaseWithRemote(reconcileInput(localPath, remotePath));

    assert.equal(report.action, "fast_forward");
    assert.equal(git(localPath, "rev-parse", "main"), remoteSha);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10 });
  }
});

test("merges cleanly diverged histories and keeps both sides reachable", async () => {
  const { directory, localPath, remotePath } = fixture();
  try {
    writeFileSync(join(remotePath, "remote.txt"), "remote\n", "utf8");
    git(remotePath, "add", ".");
    git(remotePath, "commit", "-m", "remote-only change");
    const remoteSha = git(remotePath, "rev-parse", "HEAD");
    writeFileSync(join(localPath, "local.txt"), "local\n", "utf8");
    git(localPath, "add", ".");
    git(localPath, "commit", "-m", "local-only change");
    const localSha = git(localPath, "rev-parse", "HEAD");

    const report = await reconcileBaseWithRemote(reconcileInput(localPath, remotePath));

    assert.equal(report.action, "merge");
    const mergedSha = git(localPath, "rev-parse", "main");
    assert.equal(git(localPath, "merge-base", "--is-ancestor", remoteSha, mergedSha), "");
    assert.equal(git(localPath, "merge-base", "--is-ancestor", localSha, mergedSha), "");
    // 監視 checkout 自体は動かしていない (branch ref だけが前進する)。
    assert.equal(git(localPath, "status", "--porcelain"), "");
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10 });
  }
});

test("leaves a conflicting divergence to a human", async () => {
  const { directory, localPath, remotePath } = fixture();
  try {
    writeFileSync(join(remotePath, "product.txt"), "base\nremote\n", "utf8");
    git(remotePath, "add", ".");
    git(remotePath, "commit", "-m", "remote conflicting change");
    writeFileSync(join(localPath, "product.txt"), "base\nlocal\n", "utf8");
    git(localPath, "add", ".");
    git(localPath, "commit", "-m", "local conflicting change");
    const beforeSha = git(localPath, "rev-parse", "main");

    await assert.rejects(
      reconcileBaseWithRemote(reconcileInput(localPath, remotePath)),
      (error) => error instanceof RevisorError && /conflict; reconcile them manually/.test(error.message),
    );
    // 失敗しても base は動いていない。
    assert.equal(git(localPath, "rev-parse", "main"), beforeSha);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10 });
  }
});

test("squash merge reconciles once and retries when GitHub moved independently", async () => {
  const { directory, localPath } = fixture();
  try {
    git(localPath, "checkout", "-b", "feat/local");
    writeFileSync(join(localPath, "product.txt"), "base\nfeature\n", "utf8");
    git(localPath, "add", "product.txt");
    git(localPath, "commit", "-m", "feature");
    const headSha = git(localPath, "rev-parse", "HEAD");
    git(localPath, "checkout", "main");

    const publishCalls = [];
    const reconcileCalls = [];
    const result = await squashMergeLocalPullRequest({
      repository: { repository: "LUDIARS/Product", rootPath: localPath, baseRef: "main" },
      pullRequest: {
        id: "pr-1",
        status: "open",
        checkStatus: "test_ok",
        baseRef: "main",
        headRef: "feat/local",
        reviewedHeadSha: headSha,
        title: "feature",
        body: "",
      },
      scan: async () => ({ status: "skipped" }),
      publish: async ({ mergeCommitSha }) => {
        publishCalls.push(mergeCommitSha);
        if (publishCalls.length === 1) {
          throw new BaseMovedError("GitHub 'main' moved independently; reconcile it with local 'main' before publishing.");
        }
        return { mergeCommitSha, releaseTag: null, releaseUrl: null };
      },
      reconcileBase: async (input) => {
        reconcileCalls.push(input.baseRef);
      },
    });

    assert.equal(publishCalls.length, 2);
    assert.deepEqual(reconcileCalls, ["main"]);
    assert.equal(git(localPath, "rev-parse", "main"), result.mergeCommitSha);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10 });
  }
});

test("retry discards the local release tag attached to an abandoned prepared merge", async () => {
  const { directory, localPath } = fixture();
  try {
    git(localPath, "checkout", "-b", "feat/local");
    writeFileSync(join(localPath, "product.txt"), "base\nfeature\n", "utf8");
    git(localPath, "add", "product.txt");
    git(localPath, "commit", "-m", "feature");
    const headSha = git(localPath, "rev-parse", "HEAD");
    git(localPath, "checkout", "main");

    let attempts = 0;
    await squashMergeLocalPullRequest({
      repository: { repository: "LUDIARS/Product", rootPath: localPath, baseRef: "main" },
      pullRequest: {
        id: "pr-release",
        status: "open",
        checkStatus: "test_ok",
        baseRef: "main",
        headRef: "feat/local",
        reviewedHeadSha: headSha,
        title: "feature",
        body: "",
      },
      scan: async () => ({ status: "skipped" }),
      publish: async ({ mergeCommitSha }) => {
        attempts += 1;
        if (attempts === 1) {
          git(localPath, "tag", "-a", "v1.2.3", mergeCommitSha, "-m", "prepared release");
          throw new BaseMovedError("GitHub 'main' moved independently; reconcile it with local 'main' before publishing.");
        }
        assert.equal(git(localPath, "tag", "--list", "v1.2.3"), "");
        return { mergeCommitSha, releaseTag: null, releaseUrl: null };
      },
      reconcileBase: async () => {},
    });

    assert.equal(attempts, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 10 });
  }
});
