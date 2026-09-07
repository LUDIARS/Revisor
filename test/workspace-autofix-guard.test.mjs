import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { advanceLocalBranch, revisorAutofixOnly, AUTOFIX_TRAILER } from "../src/workspace.mjs";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

/**
 * 「審査中にブランチが変わった」ガードは正しい (提出者が提出後にコミットを足す事故を
 * 止める) が、Revisor 自身の autofix コミットまで外部変更として弾いていた。autofix が
 * 入る PR は必ず一度 failed になり、人手の `pr retry --force` が要る状態だった
 * (2026-09-05 に 1 日 4 件、うち 2 件が autofix 起因)。
 */

function git(repoPath, ...args) {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "revisor-autofix-guard-"));
  const repoPath = join(directory, "Product");
  const init = spawnSync("git", ["init", repoPath], { encoding: "utf8", windowsHide: true });
  if (init.status !== 0) throw new Error(init.stderr || init.stdout);
  git(repoPath, "checkout", "-b", "main");
  git(repoPath, "config", "user.name", "Test");
  git(repoPath, "config", "user.email", "test@example.invalid");
  writeFileSync(join(repoPath, "a.txt"), "base\n", "utf8");
  git(repoPath, "add", "a.txt");
  git(repoPath, "commit", "-m", "base");
  git(repoPath, "checkout", "-b", "feat/local");
  return { directory, repoPath };
}

/** ブランチ上に 1 コミット足して sha を返す。 */
function commit(repoPath, file, body, message, extra = []) {
  writeFileSync(join(repoPath, file), body, "utf8");
  git(repoPath, "add", file);
  git(repoPath, "commit", "-m", message, ...extra.flatMap((m) => ["-m", m]));
  return git(repoPath, "rev-parse", "HEAD");
}

const autofix = (repoPath, file, body) =>
  commit(repoPath, file, body, "fix(pr-review): apply automated review fixes", [AUTOFIX_TRAILER]);

test("revisorAutofixOnly: autofix コミットだけなら true", async () => {
  const { directory, repoPath } = fixture();
  try {
    const before = git(repoPath, "rev-parse", "HEAD");
    autofix(repoPath, "a.txt", "base\nfix1\n");
    const after = autofix(repoPath, "a.txt", "base\nfix1\nfix2\n");
    assert.equal(await revisorAutofixOnly(repoPath, before, after), true);
  } finally {
    await removeFixture(directory);
  }
});

test("revisorAutofixOnly: 提出者のコミットが混じれば false", async () => {
  const { directory, repoPath } = fixture();
  try {
    const before = git(repoPath, "rev-parse", "HEAD");
    autofix(repoPath, "a.txt", "base\nfix\n");
    const after = commit(repoPath, "a.txt", "base\nfix\nmine\n", "docs: add task md");
    assert.equal(await revisorAutofixOnly(repoPath, before, after), false);
  } finally {
    await removeFixture(directory);
  }
});

test("revisorAutofixOnly: 進んでいなければ false (自己要因を作らない)", async () => {
  const { directory, repoPath } = fixture();
  try {
    const head = git(repoPath, "rev-parse", "HEAD");
    assert.equal(await revisorAutofixOnly(repoPath, head, head), false);
  } finally {
    await removeFixture(directory);
  }
});

test("revisorAutofixOnly: 目印を本文に引用しただけのコミットは自己要因にしない", async () => {
  const { directory, repoPath } = fixture();
  try {
    const before = git(repoPath, "rev-parse", "HEAD");
    // この機能を説明する commit や task md を引用すると、本文に目印の文字列が載る。
    // 部分文字列で判定していると、提出者のコミットが autofix に化ける。
    const after = commit(
      repoPath,
      "a.txt",
      "base\nmine\n",
      "docs: describe the autofix guard",
      [`autofix commits carry ${AUTOFIX_TRAILER} as a trailer.`],
    );
    assert.equal(await revisorAutofixOnly(repoPath, before, after), false);
  } finally {
    await removeFixture(directory);
  }
});

test("revisorAutofixOnly: 本文が空のコミットは自己要因にしない", async () => {
  const { directory, repoPath } = fixture();
  try {
    const before = git(repoPath, "rev-parse", "HEAD");
    autofix(repoPath, "a.txt", "base\nfix\n");
    writeFileSync(join(repoPath, "a.txt"), "base\nfix\nmine\n", "utf8");
    git(repoPath, "add", "a.txt");
    git(repoPath, "commit", "--allow-empty-message", "-m", "");
    const after = git(repoPath, "rev-parse", "HEAD");
    assert.equal(await revisorAutofixOnly(repoPath, before, after), false);
  } finally {
    await removeFixture(directory);
  }
});

test("advanceLocalBranch: 自分の autofix で進んだ分は失敗させず続行する", async () => {
  const { directory, repoPath } = fixture();
  try {
    const enqueued = git(repoPath, "rev-parse", "HEAD");
    // 審査中に Revisor 自身が autofix を積み、ブランチが動いた状態。
    const afterAutofix = autofix(repoPath, "a.txt", "base\nfix\n");
    // その上に積んだ次のコミットへ進める。
    const next = autofix(repoPath, "a.txt", "base\nfix\nmore\n");
    git(repoPath, "reset", "--hard", afterAutofix);

    const advanced = await advanceLocalBranch(repoPath, "feat/local", enqueued, next);
    assert.equal(advanced, next);
    assert.equal(git(repoPath, "rev-parse", "refs/heads/feat/local"), next);
  } finally {
    await removeFixture(directory);
  }
});

test("advanceLocalBranch: 提出者が足したコミットでは従来どおり失敗する", async () => {
  const { directory, repoPath } = fixture();
  try {
    const enqueued = git(repoPath, "rev-parse", "HEAD");
    const external = commit(repoPath, "a.txt", "base\nmine\n", "docs: add task md");
    await assert.rejects(
      advanceLocalBranch(repoPath, "feat/local", enqueued, external),
      /changed while Revisor was working \(external commits/,
    );
  } finally {
    await removeFixture(directory);
  }
});

test("advanceLocalBranch: 自己要因と外部要因で文面が異なる (原因を切り分けられる)", async () => {
  const { directory, repoPath } = fixture();
  try {
    const enqueued = git(repoPath, "rev-parse", "HEAD");
    const afterAutofix = autofix(repoPath, "a.txt", "base\nfix\n");
    // autofix の上に載っていない sha へ進めようとした場合 (取りこぼしになる)。
    git(repoPath, "checkout", "-b", "tmp", enqueued);
    const sibling = commit(repoPath, "b.txt", "sibling\n", "chore: sibling");
    git(repoPath, "checkout", "feat/local");
    git(repoPath, "reset", "--hard", afterAutofix);

    await assert.rejects(
      advanceLocalBranch(repoPath, "feat/local", enqueued, sibling),
      /refusing to drop the autofix commits/,
    );
  } finally {
    await removeFixture(directory);
  }
});

test("advanceLocalBranch: 既に autofix が反映済みなら現在の tip を返す (冪等)", async () => {
  const { directory, repoPath } = fixture();
  try {
    const enqueued = git(repoPath, "rev-parse", "HEAD");
    const afterAutofix = autofix(repoPath, "a.txt", "base\nfix\n");
    const advanced = await advanceLocalBranch(repoPath, "feat/local", enqueued, afterAutofix);
    assert.equal(advanced, afterAutofix);
  } finally {
    await removeFixture(directory);
  }
});
