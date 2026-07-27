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
import { LocalPrService } from "../src/local-pr-service.mjs";
import { LocalPrStore } from "../src/state-store.mjs";

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
