import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  cleanupWorktrees,
  diffPatchId,
  git as revisorGit,
  NO_LFS_FILTER_ARGS,
  prepareLocalWorktrees,
} from "../src/workspace.mjs";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

function git(repoPath, ...args) {
  const result = spawnSync("git", [...NO_LFS_FILTER_ARGS, "-C", repoPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function repositoryFixture() {
  const directory = mkdtempSync(join(tmpdir(), "revisor-workspace-"));
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
  git(repoPath, "checkout", "-b", "feat/local");
  writeFileSync(join(repoPath, "product.txt"), "base\nfeature\n", "utf8");
  git(repoPath, "add", "product.txt");
  git(repoPath, "commit", "-m", "feature");
  git(repoPath, "checkout", "main");
  return {
    directory,
    repoPath,
    headSha: git(repoPath, "rev-parse", "refs/heads/feat/local"),
  };
}

function request(fixture, overrides = {}) {
  return {
    rootPath: fixture.repoPath,
    reviewRootPath: fixture.repoPath,
    headRef: "feat/local",
    baseRef: "main",
    headSha: fixture.headSha,
    ...overrides,
  };
}

// フィルタ名に `lfs` を使わないのは意図的。 ホストに `git lfs install` 済みだと
// `filter.lfs.process = git-lfs filter-process` が system や global に載りうる。
// 上位スコープに `process` があると、 下位で空文字にしてもその値を unset して
// clean/smudge へフォールバックさせることはできない — git は「空の process コマンドが
// 設定されている」と解釈して `clean filter 'lfs' failed` で落ちる
// (`-c filter.lfs.process=` でも同じ)。つまり `lfs` という名前では、 git-lfs が入った
// ホストで clean 経路を検証できない。
//
// 検証したいのは「共有 git 境界がリポジトリ設定の clean filter を素通しするか」であって
// LFS 固有の挙動ではないので、 衝突しない名前で同じ境界を確かめる。
test("the shared git boundary preserves a working clean filter", async () => {
  const directory = mkdtempSync(join(tmpdir(), "revisor-workspace-clean-filter-"));
  const repoPath = join(directory, "Product");
  const filterPath = join(directory, "clean-filter.mjs");
  const init = spawnSync("git", ["init", repoPath], { encoding: "utf8", windowsHide: true });
  if (init.status !== 0) throw new Error(init.stderr || init.stdout);
  try {
    writeFileSync(
      filterPath,
      "let value = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { value += chunk; }); process.stdin.on('end', () => process.stdout.write(`filtered:${value}`));\n",
      "utf8",
    );
    writeFileSync(join(repoPath, ".gitattributes"), "*.bin filter=revisorprobe -text\n", "utf8");
    writeFileSync(join(repoPath, "asset.bin"), "asset content\n", "utf8");
    const commandPath = filterPath.replaceAll("\\", "/");
    git(repoPath, "config", "filter.revisorprobe.clean", `node \"${commandPath}\"`);
    git(repoPath, "config", "filter.revisorprobe.required", "true");

    await revisorGit(repoPath, ["add", "asset.bin"]);

    assert.equal(git(repoPath, "show", ":asset.bin"), "filtered:asset content");
  } finally {
    removeFixture(directory);
  }
});

test("cleanup removes both disposable worktrees and the temp root", async () => {
  const fixture = repositoryFixture();
  try {
    const worktrees = await prepareLocalWorktrees(request(fixture));
    assert.equal(existsSync(worktrees.head), true);
    assert.equal(existsSync(worktrees.base), true);

    await cleanupWorktrees(fixture.repoPath, worktrees);

    assert.equal(existsSync(worktrees.root), false);
    const remaining = git(fixture.repoPath, "worktree", "list", "--porcelain")
      .split(/\r?\n\r?\n/)
      .filter(Boolean);
    assert.equal(remaining.length, 1);
  } finally {
    removeFixture(fixture.directory);
  }
});

// 設定の目的は「審査 worktree を別ドライブへ逃がす」ことなので、置き場所の単体試験
// だけでは足りない。設定は読めているのに worktree が OS 一時領域に出る配線漏れを、
// 実際の worktree 生成経路で捕まえる。親が未作成でも作られることも同時に見る。
test("places the disposable worktrees under the configured scratch root", async () => {
  const fixture = repositoryFixture();
  const scratchRoot = join(fixture.directory, "scratch", "revisor");
  let worktrees = null;
  try {
    worktrees = await prepareLocalWorktrees(request(fixture), {
      reviewScratchRoot: scratchRoot,
    });

    assert.equal(dirname(worktrees.root), scratchRoot);
    assert.equal(existsSync(worktrees.head), true);
    assert.equal(existsSync(worktrees.base), true);
  } finally {
    if (worktrees) await cleanupWorktrees(fixture.repoPath, worktrees);
    removeFixture(fixture.directory);
  }
});

test("prepares the review after the base advances", async () => {
  const fixture = repositoryFixture();
  let worktrees = null;
  try {
    const originalBaseSha = git(fixture.repoPath, "rev-parse", "refs/heads/main");
    writeFileSync(join(fixture.repoPath, "other.txt"), "base moved\n", "utf8");
    git(fixture.repoPath, "add", "other.txt");
    git(fixture.repoPath, "commit", "-m", "base moves");

    worktrees = await prepareLocalWorktrees(request(fixture, { baseSha: originalBaseSha }));

    assert.equal(existsSync(worktrees.head), true);
    assert.equal(existsSync(worktrees.base), true);
  } finally {
    if (worktrees) await cleanupWorktrees(fixture.repoPath, worktrees);
    removeFixture(fixture.directory);
  }
});

// 登録元 checkout の base ref は、 マージのたびには追随しない
// (spec/feature/checkout-publication.md)。 そこを審査の差分起点にすると、 他 PR が
// マージしたぶん (ここでは other.txt) までこの PR の変更として審査へ渡ってしまう。
// 起点は実際に squash 先となる merge repository の base ref でなければならない
// (spec/feature/review-diff-scope.md)。
test("the review diff starts at the merge repository's base, not the stale registered one", async () => {
  const directory = mkdtempSync(join(tmpdir(), "revisor-workspace-stale-base-"));
  const repoPath = join(directory, "Product");
  const mergeRepoPath = join(directory, "merge-repository");
  const init = spawnSync("git", ["init", repoPath], { encoding: "utf8", windowsHide: true });
  if (init.status !== 0) throw new Error(init.stderr || init.stdout);
  git(repoPath, "checkout", "-b", "main");
  git(repoPath, "config", "user.name", "Test");
  git(repoPath, "config", "user.email", "test@example.invalid");
  writeFileSync(join(repoPath, "product.txt"), "base\n", "utf8");
  git(repoPath, "add", "product.txt");
  git(repoPath, "commit", "-m", "base");
  // 登録元 checkout の main はここで止まったままになる。
  const staleBaseSha = git(repoPath, "rev-parse", "refs/heads/main");
  git(repoPath, "checkout", "-b", "feat/local");
  // 他 PR の変更。 merge repository の main には入っており、 この head も既に含む。
  writeFileSync(join(repoPath, "other.txt"), "another pull request\n", "utf8");
  git(repoPath, "add", "other.txt");
  git(repoPath, "commit", "-m", "another pull request");
  const currentBaseSha = git(repoPath, "rev-parse", "HEAD");
  writeFileSync(join(repoPath, "product.txt"), "base\nfeature\n", "utf8");
  git(repoPath, "add", "product.txt");
  git(repoPath, "commit", "-m", "feature");
  const headSha = git(repoPath, "rev-parse", "refs/heads/feat/local");
  git(repoPath, "checkout", "main");

  const clone = spawnSync("git", ["clone", "--no-checkout", repoPath, mergeRepoPath], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (clone.status !== 0) throw new Error(clone.stderr || clone.stdout);
  // Revisor 所有のマージ先。 登録元より先へ進んでいる。
  git(mergeRepoPath, "update-ref", "refs/heads/main", currentBaseSha);
  assert.notEqual(staleBaseSha, currentBaseSha);

  let worktrees = null;
  try {
    worktrees = await prepareLocalWorktrees({
      rootPath: repoPath,
      reviewRootPath: mergeRepoPath,
      headRef: "feat/local",
      baseRef: "main",
      headSha,
    });

    assert.equal(worktrees.mergeBase, currentBaseSha);
    const changed = git(
      repoPath,
      "diff",
      "--name-only",
      `${worktrees.mergeBase}..${headSha}`,
    ).split(/\r?\n/).filter(Boolean);
    assert.deepEqual(changed, ["product.txt"]);
  } finally {
    if (worktrees) await cleanupWorktrees(repoPath, worktrees);
    removeFixture(directory);
  }
});

// `git lfs install` points `filter.lfs.process` (and smudge/clean) at the
// `git-lfs` binary; when that binary is missing, launching the filter fails
// and Git aborts the whole checkout non-zero. Revisor's disposable review
// worktrees never need real LFS content, so worktree creation must still
// succeed and simply leave the raw pointer/text content in place.
test("worktree add succeeds when a repo's LFS filter binary is unavailable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "revisor-workspace-lfs-"));
  const repoPath = join(directory, "Product");
  const init = spawnSync("git", ["init", repoPath], { encoding: "utf8", windowsHide: true });
  if (init.status !== 0) throw new Error(init.stderr || init.stdout);
  git(repoPath, "checkout", "-b", "main");
  git(repoPath, "config", "user.name", "Test");
  git(repoPath, "config", "user.email", "test@example.invalid");
  writeFileSync(join(repoPath, ".gitattributes"), "*.bin filter=lfs -text\n", "utf8");
  git(repoPath, "add", ".gitattributes");
  git(repoPath, "commit", "-m", "attrs");
  writeFileSync(join(repoPath, "asset.bin"), "binary asset content\n", "utf8");
  git(repoPath, "add", "asset.bin");
  git(repoPath, "commit", "-m", "asset");
  git(repoPath, "checkout", "-b", "feat/local");
  writeFileSync(join(repoPath, "asset.bin"), "binary asset content changed\n", "utf8");
  git(repoPath, "add", "asset.bin");
  git(repoPath, "commit", "-m", "feature");
  const headSha = git(repoPath, "rev-parse", "refs/heads/feat/local");
  git(repoPath, "checkout", "main");
  // The filter commands are only configured now, after the content committed
  // above, mirroring a machine where git-lfs was never installed: Git only
  // needs to launch the filter when checking out (worktree add), not at commit
  // time.
  git(repoPath, "config", "filter.lfs.process", "git-lfs-missing-binary filter-process");
  git(repoPath, "config", "filter.lfs.smudge", "git-lfs-missing-binary smudge -- %f");
  git(repoPath, "config", "filter.lfs.clean", "git-lfs-missing-binary clean -- %f");
  git(repoPath, "config", "filter.lfs.required", "true");

  let worktrees = null;
  try {
    worktrees = await prepareLocalWorktrees({
      rootPath: repoPath,
      reviewRootPath: repoPath,
      headRef: "feat/local",
      baseRef: "main",
      headSha,
    });

    assert.equal(existsSync(worktrees.head), true);
    assert.equal(existsSync(worktrees.base), true);
  } finally {
    if (worktrees) await cleanupWorktrees(repoPath, worktrees);
    removeFixture(directory);
  }
});

// A temp directory the filesystem refuses to delete (Windows EBUSY/EPERM while an
// on-access scanner or an exiting child still holds a handle) must not turn an
// otherwise complete review into a failed one.
test("cleanup survives a temp root that cannot be removed", async () => {
  const fixture = repositoryFixture();
  let worktrees = null;
  try {
    worktrees = await prepareLocalWorktrees(request(fixture));
    let attempted = null;

    await cleanupWorktrees(fixture.repoPath, worktrees, {
      removeRoot: (root) => {
        attempted = root;
        return Promise.reject(Object.assign(new Error("EBUSY"), { code: "EBUSY" }));
      },
    });

    assert.equal(attempted, worktrees.root);
    // The worktree registrations are still released; only the directory lingers.
    const remaining = git(fixture.repoPath, "worktree", "list", "--porcelain")
      .split(/\r?\n\r?\n/)
      .filter(Boolean);
    assert.equal(remaining.length, 1);
  } finally {
    // The stub kept the real deletion from running, so drop the root here.
    if (worktrees) removeFixture(worktrees.root);
    removeFixture(fixture.directory);
  }
});

// 指紋は「審査した内容そのものか」の判定に使われる。 rebase で SHA だけが変わった
// ヘッドでは一致し、内容が変われば変わることがこの関数の全てなので、そこを直接押さえる。
test("the diff fingerprint survives a rebase and changes with the content", async () => {
  const fixture = repositoryFixture();
  try {
    const baseSha = git(fixture.repoPath, "rev-parse", "refs/heads/main");
    const before = await diffPatchId(fixture.repoPath, fixture.headSha, baseSha);
    assert.match(before, /^[0-9a-f]{40,}$/);

    // base が別ファイルで前進し、ヘッドはその上へ rebase される (SHA だけが変わる)。
    writeFileSync(join(fixture.repoPath, "other.txt"), "other\n", "utf8");
    git(fixture.repoPath, "add", "other.txt");
    git(fixture.repoPath, "commit", "-m", "base moves");
    git(fixture.repoPath, "checkout", "feat/local");
    git(fixture.repoPath, "rebase", "main");
    const rebasedSha = git(fixture.repoPath, "rev-parse", "refs/heads/feat/local");
    const movedBase = git(fixture.repoPath, "rev-parse", "refs/heads/main");
    assert.notEqual(rebasedSha, fixture.headSha);

    assert.equal(await diffPatchId(fixture.repoPath, rebasedSha, movedBase), before);

    writeFileSync(join(fixture.repoPath, "product.txt"), "base\nfeature\nmore\n", "utf8");
    git(fixture.repoPath, "add", "product.txt");
    git(fixture.repoPath, "commit", "-m", "more");
    const changedSha = git(fixture.repoPath, "rev-parse", "refs/heads/feat/local");
    git(fixture.repoPath, "checkout", "main");

    assert.notEqual(await diffPatchId(fixture.repoPath, changedSha, movedBase), before);
  } finally {
    removeFixture(fixture.directory);
  }
});

// SHA は Git 由来の値しか渡らない想定だが、argv と `a..b` を組み立てる境界なので
// 形の検証はここで完結させる (`-` 始まりが option として解釈される経路を残さない)。
test("the diff fingerprint refuses an argument that is not an object name", async () => {
  const fixture = repositoryFixture();
  try {
    const baseSha = git(fixture.repoPath, "rev-parse", "refs/heads/main");
    await assert.rejects(
      diffPatchId(fixture.repoPath, "--output=/tmp/pwned", baseSha),
      /not a Git object name/,
    );
    await assert.rejects(
      diffPatchId(fixture.repoPath, fixture.headSha, "HEAD"),
      /not a Git object name/,
    );
  } finally {
    removeFixture(fixture.directory);
  }
});
