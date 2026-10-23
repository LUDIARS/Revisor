import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
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
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

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
    removeFixture(fixture.directory);
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
    removeFixture(fixture.directory);
  }
});

function mergePullRequest(fixture, id) {
  return {
    id,
    number: 3386,
    status: "open",
    checkStatus: "test_ok",
    title: "stale prepared merge",
    body: "",
    headRef: "feat/local",
    baseRef: "main",
    headSha: fixture.headSha,
    baseSha: fixture.baseSha,
    reviewedHeadSha: fixture.headSha,
  };
}

// Leave a prepared merge on the clone's current base, as a merge whose GitHub
// publication failed does: the recovery ref survives and the base stays put.
async function interruptPublication(repository, pullRequest, statePath) {
  const mergeRepository = await prepareMergeRepository({ repository, pullRequest, statePath });
  let preparedSha = null;
  await assert.rejects(squashMergeLocalPullRequest({
    repository: mergeRepository,
    pullRequest,
    scan: async () => ({ status: "passed" }),
    log: () => {},
    logEvent: () => {},
    publish: async ({ mergeCommitSha }) => {
      preparedSha = mergeCommitSha;
      throw new Error("GitHub 'main' is not contained in the local source of truth.");
    },
  }), /not contained/);
  assert.equal(git(mergeRepository.rootPath, "rev-parse", `${preparedSha}^`), pullRequest.baseSha);
  assert.equal(git(mergeRepository.rootPath, "rev-parse", "refs/heads/main"), pullRequest.baseSha);
  return { mergeRoot: mergeRepository.rootPath, preparedSha };
}

test("follows a fast-forwarded registered checkout and rebuilds the unpublished prepared merge", async () => {
  const fixture = repositoryFixture();
  const statePath = join(fixture.directory, "state", "revisor.state.json");
  const repository = { repository: "LUDIARS/Product", rootPath: fixture.sourceRoot };
  const pullRequest = mergePullRequest(fixture, "pr-stale-prepared");
  try {
    const { preparedSha } = await interruptPublication(repository, pullRequest, statePath);
    // GitHub main moved ahead; the operator ran `git merge --ff-only origin/main`
    // in the registered checkout (Praeforma #3386).
    writeFileSync(join(fixture.sourceRoot, "upstream.txt"), "landed on GitHub\n", "utf8");
    git(fixture.sourceRoot, "add", "upstream.txt");
    git(fixture.sourceRoot, "commit", "-m", "published elsewhere");
    const githubBaseSha = git(fixture.sourceRoot, "rev-parse", "refs/heads/main");

    const mergeRepository = await prepareMergeRepository({ repository, pullRequest, statePath });
    assert.equal(git(mergeRepository.rootPath, "rev-parse", "refs/heads/main"), githubBaseSha);

    const events = [];
    const calls = [];
    const publication = await squashMergeLocalPullRequest({
      repository: mergeRepository,
      pullRequest,
      scan: async () => ({ status: "passed" }),
      readPublishedBase: async () => githubBaseSha,
      log: () => {},
      logEvent: (event, fields) => events.push({ event, fields }),
      publish: async (request) => {
        calls.push(request);
        return { mergeCommitSha: request.mergeCommitSha, releaseTag: null, releaseUrl: null };
      },
    });

    const started = events.find(({ event }) => event === "merge_attempt_started");
    assert.equal(started.fields.baseSha, githubBaseSha);
    assert.equal(events.some(({ event }) => event === "merge_prepared_reused"), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].expectedBaseSha, githubBaseSha);
    assert.notEqual(publication.mergeCommitSha, preparedSha);
    assert.equal(
      git(mergeRepository.rootPath, "rev-parse", `${publication.mergeCommitSha}^`),
      githubBaseSha,
    );
    assert.equal(
      git(mergeRepository.rootPath, "rev-parse", "refs/heads/main"),
      publication.mergeCommitSha,
    );
    // The registered checkout is only read.
    assert.equal(git(fixture.sourceRoot, "rev-parse", "refs/heads/main"), githubBaseSha);
  } finally {
    removeFixture(fixture.directory);
  }
});

test("still reuses a published prepared merge after the registered checkout caught up to it", async () => {
  const fixture = repositoryFixture();
  const statePath = join(fixture.directory, "state", "revisor.state.json");
  const repository = { repository: "LUDIARS/Product", rootPath: fixture.sourceRoot };
  const pullRequest = mergePullRequest(fixture, "pr-published-prepared");
  try {
    const { mergeRoot, preparedSha } = await interruptPublication(repository, pullRequest, statePath);
    // The push reached GitHub before the process stopped, and the operator
    // fast-forwarded the registered checkout to GitHub's main.
    git(
      fixture.sourceRoot,
      "fetch",
      "--no-tags",
      mergeRoot,
      "+refs/revisor/prepared/*:refs/revisor/prepared/*",
    );
    git(fixture.sourceRoot, "merge", "--ff-only", preparedSha);

    const mergeRepository = await prepareMergeRepository({ repository, pullRequest, statePath });
    assert.equal(git(mergeRepository.rootPath, "rev-parse", "refs/heads/main"), preparedSha);

    const events = [];
    const calls = [];
    const publication = await squashMergeLocalPullRequest({
      repository: mergeRepository,
      pullRequest,
      scan: async () => ({ status: "passed" }),
      readPublishedBase: async () => preparedSha,
      log: () => {},
      logEvent: (event) => events.push(event),
      publish: async (request) => {
        calls.push(request);
        return { mergeCommitSha: request.mergeCommitSha, releaseTag: null, releaseUrl: null };
      },
    });

    assert.equal(events.includes("merge_prepared_reused"), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].mergeCommitSha, preparedSha);
    assert.equal(calls[0].expectedBaseSha, fixture.baseSha);
    assert.equal(publication.mergeCommitSha, preparedSha);
    assert.equal(git(mergeRepository.rootPath, "rev-parse", "refs/heads/main"), preparedSha);
  } finally {
    removeFixture(fixture.directory);
  }
});

test("keeps a merge base that is ahead of the registered checkout", async () => {
  const fixture = repositoryFixture();
  const statePath = join(fixture.directory, "state", "revisor.state.json");
  const repository = { repository: "LUDIARS/Product", rootPath: fixture.sourceRoot };
  const pullRequest = { headRef: "feat/local", baseRef: "main" };
  try {
    const first = await prepareMergeRepository({ repository, pullRequest, statePath });
    // A merge already advanced the clone; the checkout has not followed yet.
    git(first.rootPath, "update-ref", "refs/heads/main", fixture.headSha, fixture.baseSha);
    const second = await prepareMergeRepository({ repository, pullRequest, statePath });
    assert.equal(git(second.rootPath, "rev-parse", "refs/heads/main"), fixture.headSha);
  } finally {
    removeFixture(fixture.directory);
  }
});

test("does not move a merge base that diverged from the registered checkout", async () => {
  const fixture = repositoryFixture();
  const statePath = join(fixture.directory, "state", "revisor.state.json");
  const repository = { repository: "LUDIARS/Product", rootPath: fixture.sourceRoot };
  const pullRequest = { headRef: "feat/local", baseRef: "main" };
  try {
    const first = await prepareMergeRepository({ repository, pullRequest, statePath });
    git(first.rootPath, "update-ref", "refs/heads/main", fixture.headSha, fixture.baseSha);
    writeFileSync(join(fixture.sourceRoot, "local-only.txt"), "checkout only\n", "utf8");
    git(fixture.sourceRoot, "add", "local-only.txt");
    git(fixture.sourceRoot, "commit", "-m", "checkout-only commit");

    const second = await prepareMergeRepository({ repository, pullRequest, statePath });
    assert.equal(git(second.rootPath, "rev-parse", "refs/heads/main"), fixture.headSha);
    assert.throws(() => git(second.rootPath, "rev-parse", "--verify", "refs/revisor/source-base/main"));
  } finally {
    removeFixture(fixture.directory);
  }
});

test("serializes concurrent preparation of the same merge repository", async () => {
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
  let inFlight = 0;
  let maximumInFlight = 0;
  const runGit = async (cwd, args) => {
    inFlight += 1;
    maximumInFlight = Math.max(maximumInFlight, inFlight);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      return git(cwd, ...args);
    } finally {
      inFlight -= 1;
    }
  };
  try {
    const [first, second] = await Promise.all([
      prepareMergeRepository({ repository, pullRequest, statePath, runGit }),
      prepareMergeRepository({ repository, pullRequest, statePath, runGit }),
    ]);

    assert.equal(first.rootPath, second.rootPath);
    assert.equal(maximumInFlight, 1);
    assert.equal(git(first.rootPath, "rev-parse", "refs/heads/main"), fixture.baseSha);
    assert.equal(git(first.rootPath, "rev-parse", "refs/heads/feat/local"), fixture.headSha);
  } finally {
    removeFixture(fixture.directory);
  }
});

test("trusts only the registered source for local clone and fetch transport", async () => {
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
  const calls = [];
  const runGit = async (cwd, args) => {
    calls.push({ cwd, args });
    const commands = ["clone", "fetch", "rev-parse", "config", "checkout", "remote"];
    const commandIndex = args.findIndex((arg) => commands.includes(arg));
    const command = args[commandIndex];
    if (command === "clone") {
      mkdirSync(args.at(-1), { recursive: true });
      return "";
    }
    if (command === "rev-parse" && args.includes("--absolute-git-dir")) {
      return join(fixture.sourceRoot, ".git");
    }
    if (command === "rev-parse" && args.includes("--is-inside-work-tree")) return "true";
    if (command === "rev-parse") return fixture.baseSha;
    if (command === "config" && args.includes("--get")) return repository.repository;
    return "";
  };
  try {
    await prepareMergeRepository({ repository, pullRequest, statePath, runGit });

    const sourcePath = fixture.sourceRoot.replaceAll("\\", "/");
    const sourceGitDirectory = join(fixture.sourceRoot, ".git").replaceAll("\\", "/");
    // Resolving the git directory already opens the contaminated source, so it
    // must carry trust too; otherwise clone is never reached on the very
    // checkout this whole boundary exists to rescue.
    const discovery = calls.find(({ args }) => args.includes("--absolute-git-dir"));
    assert.deepEqual(discovery.args.slice(0, 4), [
      "-c",
      `safe.directory=${fixture.sourceRoot.replaceAll("\\", "/")}`,
      "-c",
      `safe.directory=${fixture.sourceRoot.replaceAll("\\", "/")}/.git`,
    ]);
    assert.equal(discovery.args.includes("safe.directory=*"), false);

    const sourceTransfers = calls.filter(({ args }) => args.includes("clone") || args.includes("fetch"));
    // clone, head fetch, and the base fetch that lets the clone follow a
    // fast-forwarded registered checkout.
    assert.equal(sourceTransfers.length, 3);
    for (const { args } of sourceTransfers) {
      assert.deepEqual(args.slice(0, 4), [
        "-c",
        `safe.directory=${sourcePath}`,
        "-c",
        `safe.directory=${sourceGitDirectory}`,
      ]);
      assert.equal(args.includes("safe.directory=*"), false);
    }
  } finally {
    removeFixture(fixture.directory);
  }
});
