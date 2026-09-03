import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { squashMergeLocalPullRequest } from "../src/local-merge.mjs";
import { publishMergedPullRequest } from "../src/release-publisher.mjs";
import { publishWithGitHubWorkflow } from "../src/github-workflow-publication.mjs";
import { publishPendingPublications } from "../src/publish-pending.mjs";
import {
  assertGitHubPublishRemoteUrl,
  pushWithLocalCredentials,
} from "../src/plain-git-publication.mjs";
import { runLocalPrCommand } from "../src/local-pr-commands.mjs";
import { resolveRepositoryWorkflow } from "../src/repository-workflow.mjs";
import { NO_LFS_FILTER_ARGS } from "../src/workspace.mjs";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

// リポジトリ別の公開ワークフロー選択 (`spec/plan/workflow-selection-design.md`)。
// GitHub Workflow は App を使わず通常 push で送り、 Revisor Workflow (既定) は不変。

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

// main 1 コミット (`.revisor-version` = 0.1.0) + feat/local 1 コミット。 初版なので
// publish は必ず v0.1.0 のリリースタグを選ぶ — タグの扱いまで検査できる。
function repositoryFixture() {
  const directory = mkdtempSync(join(tmpdir(), "revisor-workflow-selection-"));
  const repoPath = join(directory, "Product");
  const init = spawnSync("git", ["init", repoPath], { encoding: "utf8", windowsHide: true });
  if (init.status !== 0) throw new Error(init.stderr || init.stdout);
  git(repoPath, "checkout", "-b", "main");
  git(repoPath, "config", "user.name", "Test");
  git(repoPath, "config", "user.email", "test@example.invalid");
  writeFileSync(join(repoPath, "product.txt"), "base\n", "utf8");
  writeFileSync(join(repoPath, ".revisor-version"), "0.1.0\n", "utf8");
  git(repoPath, "add", ".");
  git(repoPath, "commit", "-m", "base");
  git(repoPath, "checkout", "-b", "feat/local");
  writeFileSync(join(repoPath, "product.txt"), "base\nfeature\n", "utf8");
  git(repoPath, "add", "product.txt");
  git(repoPath, "commit", "-m", "feature");
  git(repoPath, "checkout", "main");
  return { directory, repoPath };
}

function mergeInput(fixture, { publish, workflow = undefined } = {}) {
  const headSha = git(fixture.repoPath, "rev-parse", "refs/heads/feat/local");
  return {
    repository: {
      repository: "MELPOT/Product",
      rootPath: fixture.repoPath,
      registeredRootPath: fixture.repoPath,
      baseRef: "main",
      ...(workflow === undefined ? {} : { workflow }),
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
    ...(publish ? { publish } : {}),
    log: () => {},
  };
}

// GitHub App 側は「触れたら失敗」にしてある。 github workflow は組み立てすら
// しないことが仕様なので、 呼ばれた時点でテストを落とす。
function forbiddenGitHubApp() {
  return {
    readCredentials: () => assert.fail("the github workflow must not read App credentials"),
    createClient: () => assert.fail("the github workflow must not build a GitHub client"),
  };
}

// 実 publish を、 push だけ差し替えて動かす。
function githubWorkflowPublish({ pushes, env = {}, fail = null }) {
  return async (request) => publishMergedPullRequest({
    ...request,
    env,
    ...forbiddenGitHubApp(),
    publishGitHubWorkflow: (call) => publishWithGitHubWorkflow({
      ...call,
      push: async (pushRequest) => {
        pushes.push(pushRequest);
        if (fail) throw fail;
        return { remoteUrl: "https://github.com/MELPOT/Product.git", refspecs: [] };
      },
    }),
  });
}

test("a github-workflow merge publishes with a plain push and never builds a GitHub client", async () => {
  const fixture = repositoryFixture();
  try {
    const pushes = [];
    const publication = await squashMergeLocalPullRequest(mergeInput(fixture, {
      workflow: "github",
      publish: githubWorkflowPublish({ pushes }),
    }));

    assert.equal(publication.publication, "published");
    assert.equal(publication.releaseTag, "v0.1.0");
    // Release は作らないので URL は無い。
    assert.equal(publication.releaseUrl, null);
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].repository, "MELPOT/Product");
    assert.equal(pushes[0].baseRef, "main");
    assert.equal(pushes[0].mergeCommitSha, publication.mergeCommitSha);
    assert.equal(pushes[0].tag, "v0.1.0");
    assert.equal(pushes[0].registeredRootPath, fixture.repoPath);
    // ローカルタグは従来どおり作る。
    assert.equal(
      git(fixture.repoPath, "rev-list", "-n", "1", "v0.1.0"),
      publication.mergeCommitSha,
    );
    assert.equal(
      git(fixture.repoPath, "rev-parse", "refs/heads/main"),
      publication.mergeCommitSha,
    );
    // 送出できたので保留は残らない。
    assert.equal(refSha(fixture.repoPath, pendingRefName("pr-1")), null);
  } finally {
    removeFixture(fixture.directory);
  }
});

test("a failed plain push completes the local merge and holds the publish", async () => {
  const fixture = repositoryFixture();
  try {
    const pushes = [];
    const publication = await squashMergeLocalPullRequest(mergeInput(fixture, {
      workflow: "github",
      publish: githubWorkflowPublish({
        pushes,
        fail: new Error("could not read Username for 'https://github.com'"),
      }),
    }));

    assert.equal(publication.publication, "deferred");
    assert.match(publication.deferredReason, /Plain push to GitHub failed/);
    assert.equal(pushes.length, 1);
    // ローカルは通常マージと同じ終局状態 + 保留の記録。
    assert.equal(
      git(fixture.repoPath, "rev-parse", "refs/heads/main"),
      publication.mergeCommitSha,
    );
    assert.equal(
      refSha(fixture.repoPath, pendingRefName("pr-1")),
      publication.mergeCommitSha,
    );

    // 後送は同じ経路をもう一度通す。 今度は push が通り、 保留が解消する。
    const retried = [];
    const updates = [];
    const summary = await publishPendingPublications({
      store: {
        path: join(fixture.directory, "revisor.state.json"),
        listRepositories: () => [{
          repository: "MELPOT/Product",
          rootPath: fixture.repoPath,
          baseRef: "main",
          workflow: "github",
        }],
        listPullRequests: () => [{
          id: "pr-1",
          number: 12,
          repository: "MELPOT/Product",
          baseRef: "main",
          status: "merged",
          publication: "deferred",
          releaseTag: "v0.1.0",
        }],
        updatePullRequest: (id, patch) => {
          updates.push({ id, patch });
          return { id, ...patch };
        },
      },
      env: {},
      resolveMergeRoot: () => fixture.repoPath,
      publish: githubWorkflowPublish({ pushes: retried }),
    });

    assert.deepEqual(
      [summary.pending, summary.published, summary.skipped, summary.failed],
      [1, 1, 0, 0],
    );
    assert.equal(retried.length, 1);
    assert.equal(retried[0].mergeCommitSha, publication.mergeCommitSha);
    assert.equal(refSha(fixture.repoPath, pendingRefName("pr-1")), null);
    assert.equal(updates[0].patch.publication, "published");
  } finally {
    removeFixture(fixture.directory);
  }
});

test("an org default selects the github workflow for a repository that does not name one", async () => {
  const fixture = repositoryFixture();
  try {
    const pushes = [];
    const publication = await squashMergeLocalPullRequest(mergeInput(fixture, {
      publish: githubWorkflowPublish({
        pushes,
        env: { REVISOR_ORG_WORKFLOWS: "MELPOT=github" },
      }),
    }));

    assert.equal(publication.publication, "published");
    assert.equal(pushes.length, 1);
  } finally {
    removeFixture(fixture.directory);
  }
});

test("workflow precedence is repository, then org default, then revisor", () => {
  const env = { REVISOR_ORG_WORKFLOWS: "MELPOT=github, Example=revisor" };
  assert.equal(resolveRepositoryWorkflow({ repository: "MELPOT/Product" }, env), "github");
  // 個別指定は org 既定を上書きする。
  assert.equal(
    resolveRepositoryWorkflow({ repository: "MELPOT/Product", workflow: "revisor" }, env),
    "revisor",
  );
  assert.equal(
    resolveRepositoryWorkflow({ repository: "LUDIARS/Revisor", workflow: "github" }, env),
    "github",
  );
  // org 既定にも個別指定にも無ければ従来どおり。
  assert.equal(resolveRepositoryWorkflow({ repository: "LUDIARS/Revisor" }, env), "revisor");
  assert.equal(resolveRepositoryWorkflow({ repository: "MELPOT/Product" }, {}), "revisor");
  // 誤記は既定へ落とさず、 設定エラーとして投げる。
  assert.throws(
    () => resolveRepositoryWorkflow({ repository: "MELPOT/Product" }, {
      REVISOR_ORG_WORKFLOWS: "MELPOT=gitub",
    }),
    /REVISOR_ORG_WORKFLOWS/,
  );
  assert.throws(
    () => resolveRepositoryWorkflow({ repository: "MELPOT/Product" }, {
      REVISOR_ORG_WORKFLOWS: "MELPOT",
    }),
    /<org>=<workflow>/,
  );
  assert.throws(
    () => resolveRepositoryWorkflow({ repository: "MELPOT/Product", workflow: "svn" }, {}),
    /must be one of revisor, github/,
  );
});

test("the plain push targets the registered checkout's origin with a fast-forward refspec", async () => {
  const remoteUrls = [];
  const calls = [];
  await pushWithLocalCredentials({
    repository: "MELPOT/Product",
    rootPath: "E:/merge-repositories/melpot-product",
    registeredRootPath: "E:/Document/MELPOT/Product",
    baseRef: "main",
    mergeCommitSha: "a".repeat(40),
    tag: "v0.1.0",
    env: {},
    runGit: async (cwd, args) => {
      remoteUrls.push({ cwd, args });
      return "https://github.com/MELPOT/Product.git";
    },
    runPush: async (request) => {
      calls.push(request);
      return "";
    },
  });

  assert.deepEqual(remoteUrls, [{
    cwd: "E:/Document/MELPOT/Product",
    args: ["remote", "get-url", "origin"],
  }]);
  assert.equal(calls.length, 1);
  // push は Revisor 所有のマージリポジトリから走る — マージコミットはそこにしかない。
  assert.equal(calls[0].cwd, "E:/merge-repositories/melpot-product");
  assert.deepEqual(calls[0].args, [
    "push",
    "--atomic",
    "https://github.com/MELPOT/Product.git",
    `${"a".repeat(40)}:refs/heads/main`,
    "refs/tags/v0.1.0:refs/tags/v0.1.0",
  ]);
});

test("the plain push falls back to the GitHub URL when the registration has no origin", async () => {
  const calls = [];
  await pushWithLocalCredentials({
    repository: "MELPOT/Product",
    rootPath: "E:/merge-repositories/melpot-product",
    registeredRootPath: "E:/Document/MELPOT/Product",
    baseRef: "main",
    mergeCommitSha: "b".repeat(40),
    env: {},
    runGit: async () => {
      throw new Error("No such remote 'origin'");
    },
    runPush: async (request) => {
      calls.push(request);
      return "";
    },
  });

  assert.deepEqual(calls[0].args, [
    "push",
    "https://github.com/MELPOT/Product.git",
    `${"b".repeat(40)}:refs/heads/main`,
  ]);
});

test("the plain push accepts only the matching GitHub origin", () => {
  assert.equal(
    assertGitHubPublishRemoteUrl("https://github.com/MELPOT/Product.git", "MELPOT/Product"),
    "https://github.com/MELPOT/Product.git",
  );
  assert.equal(
    assertGitHubPublishRemoteUrl("git@github.com:MELPOT/Product.git", "MELPOT/Product"),
    "git@github.com:MELPOT/Product.git",
  );
  assert.equal(
    assertGitHubPublishRemoteUrl("ssh://git@github.com/MELPOT/Product.git", "MELPOT/Product"),
    "ssh://git@github.com/MELPOT/Product.git",
  );
  for (const remoteUrl of [
    "https://github.com/MELPOT/Other.git",
    "https://credentials.example/MELPOT/Product.git",
    "https://github.com:444/MELPOT/Product.git",
    "ext::echo unexpected",
    "file:///MELPOT/Product.git",
  ]) {
    assert.throws(
      () => assertGitHubPublishRemoteUrl(remoteUrl, "MELPOT/Product"),
      /Registered origin is not a GitHub URL/,
    );
  }
});

function commandContext(repositories, updates) {
  return {
    store: {
      listRepositories: () => repositories,
      updateRepositoryWorkflow: (repository, workflow) => {
        const existing = repositories.find((candidate) =>
          candidate.repository.toLowerCase() === String(repository).toLowerCase());
        if (!existing) return null;
        updates.push({ repository, workflow });
        return { ...existing, workflow };
      },
    },
    jobs: {},
    localPrService: {},
  };
}

test("repo set-workflow updates one registration and rejects invalid input", async () => {
  const repositories = [{
    repository: "MELPOT/KuzuSurvivors",
    rootPath: "E:/Document/MELPOT/KuzuSurvivors",
  }];
  const updates = [];
  const written = [];
  const options = {
    env: {},
    stdout: { write: (value) => written.push(value) },
    createContext: () => commandContext(repositories, updates),
  };

  assert.equal(
    await runLocalPrCommand(["repo", "set-workflow", "MELPOT/KuzuSurvivors", "github"], options),
    0,
  );
  assert.deepEqual(updates, [{ repository: "MELPOT/KuzuSurvivors", workflow: "github" }]);
  assert.match(written[0], /MELPOT\/KuzuSurvivors now publishes with the github workflow/);

  await assert.rejects(
    runLocalPrCommand(["repo", "set-workflow", "MELPOT/KuzuSurvivors", "gitub"], options),
    /must be one of revisor, github/,
  );
  await assert.rejects(
    runLocalPrCommand(["repo", "set-workflow", "MELPOT/KuzuSurvivors"], options),
    /must be one of revisor, github/,
  );
  await assert.rejects(
    runLocalPrCommand(["repo", "set-workflow", "MELPOT/Absent", "github"], options),
    /is not registered/,
  );
  await assert.rejects(
    runLocalPrCommand(["repo", "set-workflow"], options),
    /requires <owner\/name>/,
  );
  // 失敗した呼び出しは記録を書き換えない。
  assert.equal(updates.length, 1);
});

test("repo list shows the resolved workflow of every registration", async () => {
  const written = [];
  await runLocalPrCommand(["repo", "list"], {
    env: { REVISOR_ORG_WORKFLOWS: "MELPOT=github" },
    stdout: { write: (value) => written.push(value) },
    createContext: () => commandContext([
      { repository: "LUDIARS/Revisor", rootPath: "E:/Document/Ars/Revisor" },
      { repository: "MELPOT/KuzuSurvivors", rootPath: "E:/Document/MELPOT/KuzuSurvivors" },
      {
        repository: "MELPOT/Product",
        rootPath: "E:/Document/MELPOT/Product",
        workflow: "revisor",
      },
    ], []),
  });

  assert.deepEqual(written[0].trim().split("\n"), [
    "LUDIARS/Revisor  revisor  E:/Document/Ars/Revisor",
    "MELPOT/KuzuSurvivors  github  E:/Document/MELPOT/KuzuSurvivors",
    "MELPOT/Product  revisor  E:/Document/MELPOT/Product",
  ]);
});
