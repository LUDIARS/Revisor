import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { initializeLocalVersion, LOCAL_VERSION_FILE } from "../src/local-version.mjs";
import {
  advanceMergeBaseAfterBootstrap,
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

function commit(repoPath, name, body, message = `add ${name}`) {
  writeFileSync(join(repoPath, name), body, "utf8");
  git(repoPath, "add", "--", name);
  git(repoPath, "commit", "-m", message);
}

/**
 * 登録 checkout と、 Revisor が実際に使う経路 (prepareMergeRepository) で作った
 * merge repository を用意する。 版数ファイルはまだ無い (= 初期化前)。
 */
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "revisor-bootstrap-merge-base-"));
  const rootPath = join(directory, "Product");
  const init = spawnSync("git", ["init", rootPath], { encoding: "utf8", windowsHide: true });
  if (init.status !== 0) throw new Error(init.stderr || init.stdout);
  git(rootPath, "checkout", "-b", "main");
  git(rootPath, "config", "user.name", "Test");
  git(rootPath, "config", "user.email", "test@example.invalid");
  commit(rootPath, "product.txt", "base\n");
  git(rootPath, "branch", "feature");

  const repository = { repository: "LUDIARS/Product", rootPath, baseRef: "main" };
  const statePath = join(directory, "state", "revisor.sqlite");
  await prepareMergeRepository({
    repository,
    pullRequest: { headRef: "feature", baseRef: "main" },
    statePath,
  });
  const mergeRoot = resolveMergeRepositoryPath({ repository, statePath });
  return { directory, rootPath, repository, statePath, mergeRoot };
}

test("初期化コミットが merge repository の base にも同じ SHA で載る", async () => {
  const { directory, rootPath, repository, statePath, mergeRoot } = await fixture();
  try {
    let result = null;
    await initializeLocalVersion(rootPath, "main", "0.1.0", {
      onBootstrapCommitted: async ({ parentSha, bootstrapSha }) => {
        result = await advanceMergeBaseAfterBootstrap({
          repository,
          statePath,
          baseRef: "main",
          parentSha,
          bootstrapSha,
        });
      },
    });

    const registered = git(rootPath, "rev-parse", "main");
    assert.equal(result.status, "advanced");
    // これが本題: 2 つの base が同じコミットを指す (= 以後のマージで分岐しない)。
    assert.equal(git(mergeRoot, "rev-parse", "refs/heads/main"), registered);
    assert.equal(git(mergeRoot, "show", `refs/heads/main:${LOCAL_VERSION_FILE}`), "uninitialized");
    // 一時 ref を残さない。
    assert.equal(
      spawnSync("git", ["-C", mergeRoot, "rev-parse", "--verify", "refs/revisor-bootstrap/main"], {
        encoding: "utf8",
        windowsHide: true,
      }).status === 0,
      false,
    );
  } finally {
    removeFixture(directory);
  }
});

test("merge repository が初期化前から揃っていなければ触らない", async () => {
  const { directory, rootPath, repository, statePath, mergeRoot } = await fixture();
  try {
    // merge repository 側だけが先に進んでいる状態 (publication 前) を作る。
    const work = join(directory, "advance");
    const clone = spawnSync("git", ["clone", mergeRoot, work], { encoding: "utf8", windowsHide: true });
    if (clone.status !== 0) throw new Error(clone.stderr || clone.stdout);
    git(work, "checkout", "main");
    git(work, "config", "user.name", "Test");
    git(work, "config", "user.email", "test@example.invalid");
    commit(work, "merged.txt", "merged\n");
    git(mergeRoot, "fetch", "--no-tags", work, "+refs/heads/main:refs/heads/main");
    const before = git(mergeRoot, "rev-parse", "refs/heads/main");

    let result = null;
    await initializeLocalVersion(rootPath, "main", "0.1.0", {
      onBootstrapCommitted: async ({ parentSha, bootstrapSha }) => {
        result = await advanceMergeBaseAfterBootstrap({
          repository, statePath, baseRef: "main", parentSha, bootstrapSha,
        });
      },
    });

    assert.equal(result.status, "not-in-step");
    assert.equal(result.mergeBaseSha, before);
    assert.equal(git(mergeRoot, "rev-parse", "refs/heads/main"), before);
  } finally {
    removeFixture(directory);
  }
});

test("merge repository がまだ無いリポでは何もしない", async () => {
  const directory = mkdtempSync(join(tmpdir(), "revisor-bootstrap-no-merge-"));
  try {
    const rootPath = join(directory, "Product");
    const init = spawnSync("git", ["init", rootPath], { encoding: "utf8", windowsHide: true });
    if (init.status !== 0) throw new Error(init.stderr || init.stdout);
    git(rootPath, "checkout", "-b", "main");
    git(rootPath, "config", "user.name", "Test");
    git(rootPath, "config", "user.email", "test@example.invalid");
    commit(rootPath, "product.txt", "base\n");
    const repository = { repository: "LUDIARS/Fresh", rootPath, baseRef: "main" };
    const statePath = join(directory, "state", "revisor.sqlite");

    let result = null;
    await initializeLocalVersion(rootPath, "main", "0.1.0", {
      onBootstrapCommitted: async ({ parentSha, bootstrapSha }) => {
        result = await advanceMergeBaseAfterBootstrap({
          repository, statePath, baseRef: "main", parentSha, bootstrapSha,
        });
      },
    });

    assert.deepEqual(result, { status: "no-merge-repository" });
  } finally {
    removeFixture(directory);
  }
});

test("既に揃っているなら already を返し、二重に動かさない", async () => {
  const { directory, rootPath, repository, statePath, mergeRoot } = await fixture();
  try {
    let bootstrap = null;
    await initializeLocalVersion(rootPath, "main", "0.1.0", {
      onBootstrapCommitted: async (commitInfo) => {
        bootstrap = commitInfo;
        await advanceMergeBaseAfterBootstrap({ repository, statePath, baseRef: "main", ...commitInfo });
      },
    });
    const again = await advanceMergeBaseAfterBootstrap({
      repository, statePath, baseRef: "main", ...bootstrap,
    });
    assert.equal(again.status, "already");
    assert.equal(git(mergeRoot, "rev-parse", "refs/heads/main"), bootstrap.bootstrapSha);
  } finally {
    removeFixture(directory);
  }
});

test("コールバックを渡さない従来の呼び出しは挙動を変えない", async () => {
  const { directory, rootPath, mergeRoot } = await fixture();
  try {
    const before = git(mergeRoot, "rev-parse", "refs/heads/main");
    assert.equal(await initializeLocalVersion(rootPath, "main", "0.1.0"), "0.1.0");
    assert.equal(git(rootPath, "log", "-1", "--format=%s"), "chore: bootstrap Revisor version state");
    assert.equal(git(mergeRoot, "rev-parse", "refs/heads/main"), before);
  } finally {
    removeFixture(directory);
  }
});
