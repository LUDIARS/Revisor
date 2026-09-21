import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { readBaseDivergence } from "../src/merge-repository.mjs";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

function git(repoPath, ...args) {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function commit(repoPath, name, body) {
  writeFileSync(join(repoPath, name), body, "utf8");
  git(repoPath, "add", "--", name);
  git(
    repoPath,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    `add ${name}`,
  );
}

/**
 * 登録元 checkout と、 そこから clone した Revisor 所有の merge repository を作る。
 * どちらも `main` を持ち、 最初は同じコミットを指している。
 */
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "revisor-base-divergence-"));
  const registered = join(directory, "Product");
  const init = spawnSync("git", ["init", registered], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (init.status !== 0) throw new Error(init.stderr || init.stdout);
  git(registered, "checkout", "-b", "main");
  commit(registered, "product.txt", "base\n");

  const mergeRoot = join(directory, "merge-repository");
  const clone = spawnSync("git", ["clone", "--no-checkout", registered, mergeRoot], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (clone.status !== 0) throw new Error(clone.stderr || clone.stdout);
  // 実物と同じく、 merge repository は branch を checkout したままにしない
  // (branch の移動を update-ref の CAS で行うため)。
  git(mergeRoot, "checkout", "--detach", git(registered, "rev-parse", "main"));
  git(mergeRoot, "update-ref", "refs/heads/main", git(registered, "rev-parse", "main"));

  return {
    directory,
    repository: { rootPath: mergeRoot, registeredRootPath: registered },
    registered,
    mergeRoot,
  };
}

test("同じコミットを指していれば diverged ではない", async () => {
  const { directory, repository } = fixture();
  try {
    const divergence = await readBaseDivergence({ repository, baseRef: "main" });
    assert.equal(divergence.diverged, false);
    assert.equal(divergence.mergeBaseSha, divergence.registeredBaseSha);
  } finally {
    removeFixture(directory);
  }
});

test("merge base だけが進んでいる状態は diverged に数えない", async () => {
  const { directory, repository, mergeRoot, registered } = fixture();
  try {
    // publication 前の正常な状態: merge repository が先に進む。
    const work = join(directory, "advance");
    const clone = spawnSync("git", ["clone", mergeRoot, work], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (clone.status !== 0) throw new Error(clone.stderr || clone.stdout);
    git(work, "checkout", "main");
    commit(work, "merged.txt", "merged\n");
    git(mergeRoot, "fetch", "--no-tags", work, "+refs/heads/main:refs/heads/main");

    const divergence = await readBaseDivergence({ repository, baseRef: "main" });
    assert.equal(divergence.diverged, false);
    assert.notEqual(divergence.mergeBaseSha, git(registered, "rev-parse", "main"));
  } finally {
    removeFixture(directory);
  }
});

test("両者が別系列になったら diverged として読める", async () => {
  const { directory, repository, mergeRoot, registered } = fixture();
  try {
    // merge repository 側が独自に進む (過去のマージが登録元へ届かなかった状態)。
    const work = join(directory, "advance");
    const clone = spawnSync("git", ["clone", mergeRoot, work], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (clone.status !== 0) throw new Error(clone.stderr || clone.stdout);
    git(work, "checkout", "main");
    commit(work, "merged.txt", "merged\n");
    git(mergeRoot, "fetch", "--no-tags", work, "+refs/heads/main:refs/heads/main");

    // 登録元は別の履歴で進む。
    commit(registered, "elsewhere.txt", "elsewhere\n");

    const divergence = await readBaseDivergence({ repository, baseRef: "main" });
    assert.equal(divergence.diverged, true);
    assert.equal(divergence.registeredBaseSha, git(registered, "rev-parse", "main"));
  } finally {
    removeFixture(directory);
  }
});

test("base ref を読めない相手なら null を返し、判定を止めない", async () => {
  const { directory, repository } = fixture();
  try {
    const missing = await readBaseDivergence({ repository, baseRef: "no-such-branch" });
    assert.equal(missing, null);
    const noRegistered = await readBaseDivergence({
      repository: { rootPath: repository.rootPath },
      baseRef: "main",
    });
    assert.equal(noRegistered, null);
  } finally {
    removeFixture(directory);
  }
});
