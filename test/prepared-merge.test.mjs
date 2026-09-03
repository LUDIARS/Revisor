import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  classifyPreparedMerge,
  readPublishedBaseSha,
} from "../src/prepared-merge.mjs";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

const ABSENT_SHA = "9999999999999999999999999999999999999999";

function git(repoPath, ...args) {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

// 準備済み squash マージ P、 その親である base A、 A から独立して進んだ base B、
// そして P を含む後続コミット D を持つリポジトリ。
function preparedFixture() {
  const directory = mkdtempSync(join(tmpdir(), "revisor-prepared-merge-"));
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
  git(repoPath, "add", ".");
  git(repoPath, "commit", "-m", "base");
  const preparedBaseSha = git(repoPath, "rev-parse", "HEAD");

  git(repoPath, "checkout", "-b", "prepared");
  writeFileSync(join(repoPath, "product.txt"), "base\nfeature\n", "utf8");
  git(repoPath, "add", "product.txt");
  git(repoPath, "commit", "-m", "feature", "-m", "Revisor-Local-PR: pr-1");
  const preparedSha = git(repoPath, "rev-parse", "HEAD");
  writeFileSync(join(repoPath, "later.txt"), "later\n", "utf8");
  git(repoPath, "add", "later.txt");
  git(repoPath, "commit", "-m", "later work on top of the prepared merge");
  const descendantSha = git(repoPath, "rev-parse", "HEAD");

  git(repoPath, "checkout", "main");
  writeFileSync(join(repoPath, "other.txt"), "other\n", "utf8");
  git(repoPath, "add", "other.txt");
  git(repoPath, "commit", "-m", "another local PR landed first");
  const movedBaseSha = git(repoPath, "rev-parse", "HEAD");

  return {
    directory,
    repoPath,
    preparedBaseSha,
    preparedSha,
    descendantSha,
    movedBaseSha,
  };
}

function classifyInput(fixture, { baseSha, readPublishedBase }) {
  return {
    repository: { repository: "LUDIARS/Product", rootPath: fixture.repoPath },
    pullRequest: { id: "pr-1", baseRef: "main" },
    prepared: { mergeCommitSha: fixture.preparedSha, tag: null },
    baseSha,
    env: {},
    readPublishedBase,
  };
}

test("reuses a prepared merge that still sits on the current base without asking GitHub", async () => {
  const fixture = preparedFixture();
  try {
    const decision = await classifyPreparedMerge(classifyInput(fixture, {
      baseSha: fixture.preparedBaseSha,
      readPublishedBase: async () => {
        throw new Error("GitHub must not be consulted for an up-to-date prepared merge");
      },
    }));

    assert.equal(decision.action, "reuse");
    assert.equal(decision.reason, "current_base");
    assert.equal(decision.notice, null);
  } finally {
    removeFixture(fixture.directory);
  }
});

test("reuses a prepared merge that GitHub already points at", async () => {
  const fixture = preparedFixture();
  try {
    const decision = await classifyPreparedMerge(classifyInput(fixture, {
      baseSha: fixture.movedBaseSha,
      readPublishedBase: async () => fixture.preparedSha,
    }));

    assert.equal(decision.action, "reuse");
    assert.equal(decision.reason, "published");
    assert.match(decision.notice, /already contains it/);
  } finally {
    removeFixture(fixture.directory);
  }
});

test("reuses a prepared merge that GitHub carried further as an ancestor", async () => {
  const fixture = preparedFixture();
  try {
    const decision = await classifyPreparedMerge(classifyInput(fixture, {
      baseSha: fixture.movedBaseSha,
      readPublishedBase: async () => fixture.descendantSha,
    }));

    assert.equal(decision.action, "reuse");
    assert.equal(decision.reason, "published");
    assert.equal(decision.publishedBaseSha, fixture.descendantSha);
  } finally {
    removeFixture(fixture.directory);
  }
});

test("discards an unpublished prepared merge once the base moved past it", async () => {
  const fixture = preparedFixture();
  try {
    const decision = await classifyPreparedMerge(classifyInput(fixture, {
      baseSha: fixture.movedBaseSha,
      readPublishedBase: async () => fixture.preparedBaseSha,
    }));

    assert.equal(decision.action, "rebuild");
    assert.equal(decision.reason, "stale");
    assert.equal(decision.preparedBaseSha, fixture.preparedBaseSha);
    assert.match(decision.notice, new RegExp(fixture.preparedSha));
    assert.match(decision.notice, new RegExp(fixture.preparedBaseSha));
    assert.match(decision.notice, new RegExp(fixture.movedBaseSha));
  } finally {
    removeFixture(fixture.directory);
  }
});

test("discards the prepared merge when the base branch is gone from GitHub", async () => {
  const fixture = preparedFixture();
  try {
    const decision = await classifyPreparedMerge(classifyInput(fixture, {
      baseSha: fixture.movedBaseSha,
      readPublishedBase: async () => null,
    }));

    assert.equal(decision.action, "rebuild");
    assert.match(decision.notice, /missing/);
  } finally {
    removeFixture(fixture.directory);
  }
});

test("keeps the prepared merge when the GitHub head is not present locally", async () => {
  const fixture = preparedFixture();
  try {
    const decision = await classifyPreparedMerge(classifyInput(fixture, {
      baseSha: fixture.movedBaseSha,
      readPublishedBase: async () => ABSENT_SHA,
    }));

    assert.equal(decision.action, "reuse");
    assert.equal(decision.reason, "unverified");
    assert.match(decision.notice, /not present locally/);
  } finally {
    removeFixture(fixture.directory);
  }
});

test("keeps the prepared merge without logging a GitHub read error", async () => {
  const fixture = preparedFixture();
  try {
    const decision = await classifyPreparedMerge(classifyInput(fixture, {
      baseSha: fixture.movedBaseSha,
      readPublishedBase: async () => {
        throw new Error("installation token request failed: installation-token");
      },
    }));

    assert.equal(decision.action, "reuse");
    assert.equal(decision.reason, "unverified");
    assert.match(decision.notice, /GitHub could not be read/);
    assert.doesNotMatch(decision.notice, /installation-token/);
  } finally {
    removeFixture(fixture.directory);
  }
});

test("reads the published base ref without leaking the installation token", async () => {
  const calls = [];
  const publishedBaseSha = await readPublishedBaseSha({
    repository: { repository: "LUDIARS/Product", rootPath: "C:/Product" },
    baseRef: "main",
    env: {},
    loadCredentials: () => ({ appId: "1", privateKey: "key" }),
    createClient: () => ({ installationToken: async () => "installation-token" }),
    runRemoteGit: async (request) => {
      calls.push(request);
      return `1111111111111111111111111111111111111111\trefs/heads/main`;
    },
  });

  assert.equal(publishedBaseSha, "1111111111111111111111111111111111111111");
  assert.deepEqual(calls[0].args, [
    "ls-remote",
    "https://github.com/LUDIARS/Product.git",
    "refs/heads/main",
  ]);
  assert.doesNotMatch(calls[0].args.join(" "), /installation-token/);
});

test("reports an absent base branch as no published head", async () => {
  const publishedBaseSha = await readPublishedBaseSha({
    repository: { repository: "LUDIARS/Product", rootPath: "C:/Product" },
    baseRef: "main",
    env: {},
    loadCredentials: () => ({ appId: "1", privateKey: "key" }),
    createClient: () => ({ installationToken: async () => "installation-token" }),
    runRemoteGit: async () => "",
  });

  assert.equal(publishedBaseSha, null);
});

test("refuses an unreadable ref listing instead of guessing a head", async () => {
  await assert.rejects(
    readPublishedBaseSha({
      repository: { repository: "LUDIARS/Product", rootPath: "C:/Product" },
      baseRef: "main",
      env: {},
      loadCredentials: () => ({ appId: "1", privateKey: "key" }),
      createClient: () => ({ installationToken: async () => "installation-token" }),
      runRemoteGit: async () => "warning: redirecting to https://github.com/LUDIARS/Product.git/",
    }),
    /unreadable listing/,
  );
});
