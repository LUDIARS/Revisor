import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { MergeConflictError, StaleReviewError } from "../src/errors.mjs";
import { squashMergeLocalPullRequest } from "../src/local-merge.mjs";
import { NO_LFS_FILTER_ARGS } from "../src/workspace.mjs";

// フィクスチャ構築は、 この機に git-lfs が入っているかどうかに左右されてはいけない。
// `.gitattributes` が `filter=lfs` を宣言した時点で、 素の `git add` / `checkout` は
// 開発者の global 設定にある本物の LFS フィルタを起動し、 実在しない OID を取りに
// ネットワークへ出て失敗する (ssh: Could not resolve host)。 本番と同じやり方で
// フィルタを空にして、 中身をそのまま記録する。
function git(repoPath, ...args) {
  const result = spawnSync("git", [...NO_LFS_FILTER_ARGS, "-C", repoPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

// src/git-publication.mjs の preparedRef と同じ導出。 復旧 ref そのものを検査する
// テストのために、 テスト側でも ref 名を組み立てる。
function preparedRefName(localPrId) {
  return `refs/revisor/prepared/${createHash("sha256").update(String(localPrId)).digest("hex")}`;
}

function refSha(repoPath, ref) {
  const result = spawnSync("git", ["-C", repoPath, "rev-parse", "--verify", ref], {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

// publish が落ちた回の残骸として prepared 復旧 ref を作る (実運用の「push 前後で
// 落ちた」状況と同じ作られ方をさせる)。
async function prepareInterruptedMerge(input) {
  await assert.rejects(
    squashMergeLocalPullRequest({
      ...input,
      publish: async () => {
        throw new Error("publication interrupted");
      },
    }),
    /publication interrupted/,
  );
  const preparedSha = refSha(input.repository.rootPath, preparedRefName(input.pullRequest.id));
  assert.ok(preparedSha, "the interrupted merge must leave a prepared recovery ref");
  return preparedSha;
}

// main 1 コミット + feat/local 1 コミットの素の作業リポジトリ。
function repositoryFixture({ withLfs = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "revisor-local-merge-"));
  const repoPath = join(directory, "Product");
  const init = spawnSync("git", ["init", repoPath], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (init.status !== 0) throw new Error(init.stderr || init.stdout);
  git(repoPath, "checkout", "-b", "main");
  git(repoPath, "config", "user.name", "Test");
  git(repoPath, "config", "user.email", "test@example.invalid");
  if (withLfs) {
    writeFileSync(join(repoPath, ".gitattributes"), "*.bin filter=lfs -text\n", "utf8");
  }
  writeFileSync(join(repoPath, "product.txt"), "base\n", "utf8");
  writeFileSync(join(repoPath, "other.txt"), "other\n", "utf8");
  if (withLfs) writeFileSync(join(repoPath, "asset.bin"), "base asset\n", "utf8");
  git(repoPath, "add", ".");
  git(repoPath, "commit", "-m", "base");
  git(repoPath, "checkout", "-b", "feat/local");
  writeFileSync(join(repoPath, "product.txt"), "base\nfeature\n", "utf8");
  if (withLfs) writeFileSync(join(repoPath, "asset.bin"), "feature asset\n", "utf8");
  git(repoPath, "add", "product.txt");
  if (withLfs) git(repoPath, "add", "asset.bin");
  git(repoPath, "commit", "-m", "feature");
  git(repoPath, "checkout", "main");
  return { directory, repoPath };
}

function configureUnavailableLfsFilter(repoPath) {
  git(repoPath, "config", "filter.lfs.process", "git-lfs-missing-binary filter-process");
  git(repoPath, "config", "filter.lfs.smudge", "git-lfs-missing-binary smudge -- %f");
  git(repoPath, "config", "filter.lfs.clean", "git-lfs-missing-binary clean -- %f");
  git(repoPath, "config", "filter.lfs.required", "true");
}

function mergeInput(fixture, overrides = {}) {
  const headSha = git(fixture.repoPath, "rev-parse", "refs/heads/feat/local");
  return {
    repository: { repository: "LUDIARS/Product", rootPath: fixture.repoPath },
    pullRequest: {
      id: "pr-1",
      status: "open",
      checkStatus: "test_ok",
      draft: false,
      title: "feature",
      body: "",
      headRef: "feat/local",
      baseRef: "main",
      headSha,
      baseSha: git(fixture.repoPath, "rev-parse", "refs/heads/main"),
      reviewedHeadSha: headSha,
      ...overrides,
    },
    scan: async () => ({ status: "passed" }),
    publish: async ({ mergeCommitSha }) => mergeCommitSha,
  };
}

test("merges even after the base advanced, as long as the squash applies cleanly", async () => {
  const fixture = repositoryFixture();
  try {
    const input = mergeInput(fixture);
    // 審査の後に base が別ファイルの変更で前進する (旧実装はここで必ず拒否した)。
    writeFileSync(join(fixture.repoPath, "other.txt"), "other\nmoved\n", "utf8");
    git(fixture.repoPath, "add", "other.txt");
    git(fixture.repoPath, "commit", "-m", "base moves");

    const mergeCommitSha = await squashMergeLocalPullRequest(input);

    assert.equal(git(fixture.repoPath, "rev-parse", "refs/heads/main"), mergeCommitSha);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("treats a rebased branch with no remaining diff as a logical merge", async () => {
  const fixture = repositoryFixture();
  try {
    const input = mergeInput(fixture);
    // Another landing applied the reviewed patch to main under a different
    // commit, then rebase dropped the now-redundant feature commit.
    git(fixture.repoPath, "cherry-pick", "refs/heads/feat/local");
    git(fixture.repoPath, "branch", "-f", "feat/local", "main");
    let scanned = false;
    let published = false;

    const mergeCommitSha = await squashMergeLocalPullRequest({
      ...input,
      scan: async () => {
        scanned = true;
        return { status: "passed" };
      },
      publish: async () => {
        published = true;
        return "unexpected-publication";
      },
      log: () => {},
    });

    assert.equal(mergeCommitSha, git(fixture.repoPath, "rev-parse", "refs/heads/main"));
    assert.equal(scanned, false);
    assert.equal(published, false);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("refuses an empty re-landing when the reviewed patch was discarded", async () => {
  const fixture = repositoryFixture();
  try {
    const input = mergeInput(fixture);
    git(fixture.repoPath, "branch", "-f", "feat/local", "main");

    await assert.rejects(
      squashMergeLocalPullRequest({ ...input, log: () => {} }),
      StaleReviewError,
    );
    assert.equal(
      git(fixture.repoPath, "rev-parse", "refs/heads/main"),
      input.pullRequest.baseSha,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("squash merges LFS-tracked changes without a local git-lfs binary", async () => {
  const fixture = repositoryFixture({ withLfs: true });
  try {
    configureUnavailableLfsFilter(fixture.repoPath);

    const mergeCommitSha = await squashMergeLocalPullRequest(mergeInput(fixture));

    assert.equal(git(fixture.repoPath, "rev-parse", "refs/heads/main"), mergeCommitSha);
    assert.equal(git(fixture.repoPath, "show", "main:asset.bin"), "feature asset");
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("a refused merge names the observed state and the recorded reasons", async () => {
  const fixture = repositoryFixture();
  try {
    await assert.rejects(
      squashMergeLocalPullRequest(mergeInput(fixture, {
        checkStatus: "action_required",
        reasons: ["The head conflicts with the current 'main'; rebase the branch and submit a new review."],
      })),
      (error) => {
        // 状態名だけだと「審査は通ったのに何を直せばいいのか」が呼び出し側に伝わらない。
        assert.match(error.message, /checkStatus='action_required'/);
        assert.match(error.message, /status='open'/);
        assert.match(error.message, /head conflicts with the current 'main'/);
        return true;
      },
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("a refused merge without recorded reasons still names the observed state", async () => {
  const fixture = repositoryFixture();
  try {
    await assert.rejects(
      squashMergeLocalPullRequest(mergeInput(fixture, { status: "closed", reasons: [] })),
      (error) => {
        assert.match(error.message, /status='closed'/);
        assert.doesNotMatch(error.message, /Recorded reasons/);
        return true;
      },
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("a refused merge redacts and flattens recorded reasons before returning them", async () => {
  const fixture = repositoryFixture();
  try {
    const token = `ghp_${"a".repeat(32)}`;
    await assert.rejects(
      squashMergeLocalPullRequest(mergeInput(fixture, {
        checkStatus: "action_required\nforged detail",
        reasons: [`first line\nsecond line: ${token}`],
      })),
      (error) => {
        assert.match(error.message, /checkStatus='action_required forged detail'/);
        assert.match(error.message, /\[redacted: github-token\]/);
        assert.doesNotMatch(error.message, /ghp_/);
        assert.doesNotMatch(error.message, /\n/);
        return true;
      },
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("legacy draft metadata does not block a Test OK merge", async () => {
  const fixture = repositoryFixture();
  try {
    const mergeCommitSha = await squashMergeLocalPullRequest(
      mergeInput(fixture, { draft: true }),
    );
    assert.equal(git(fixture.repoPath, "rev-parse", "refs/heads/main"), mergeCommitSha);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("an explicit human override bypasses an unavailable pre-merge scanner", async () => {
  const fixture = repositoryFixture();
  try {
    const mergeCommitSha = await squashMergeLocalPullRequest({
      ...mergeInput(fixture),
      allowSystemFailureOverride: true,
      scan: async () => ({ status: "error", reason: "scanner executable missing" }),
    });
    assert.equal(git(fixture.repoPath, "rev-parse", "refs/heads/main"), mergeCommitSha);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("a human override never bypasses actual security findings", async () => {
  const fixture = repositoryFixture();
  try {
    await assert.rejects(
      squashMergeLocalPullRequest({
        ...mergeInput(fixture),
        allowSystemFailureOverride: true,
        scan: async () => ({
          status: "findings",
          totalFindings: 1,
          failOnSeverity: "high",
          reason: "finding remains",
        }),
      }),
      /security finding/,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("reuses a tagged prepared merge when publication is retried", async () => {
  const fixture = repositoryFixture();
  try {
    const input = mergeInput(fixture);
    const baseSha = git(fixture.repoPath, "rev-parse", "refs/heads/main");
    git(fixture.repoPath, "checkout", "--detach", baseSha);
    git(fixture.repoPath, "merge", "--squash", "refs/heads/feat/local");
    git(
      fixture.repoPath,
      "commit",
      "-m",
      "feature",
      "-m",
      `Revisor-Local-PR: ${input.pullRequest.id}`,
    );
    const preparedSha = git(fixture.repoPath, "rev-parse", "HEAD");
    git(fixture.repoPath, "tag", "-a", "v1.2.3", "-m", "prepared release");
    git(fixture.repoPath, "checkout", "main");

    const calls = [];
    const publication = await squashMergeLocalPullRequest({
      ...input,
      scan: async () => {
        throw new Error("a prepared merge must not be rebuilt or rescanned");
      },
      publish: async (request) => {
        calls.push(request);
        return {
          mergeCommitSha: request.mergeCommitSha,
          releaseTag: request.preparedTag,
          releaseUrl: "https://github.example/releases/v1.2.3",
        };
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].expectedBaseSha, baseSha);
    assert.equal(calls[0].mergeCommitSha, preparedSha);
    assert.equal(calls[0].preparedTag, "v1.2.3");
    assert.equal(publication.releaseTag, "v1.2.3");
    assert.equal(git(fixture.repoPath, "rev-parse", "refs/heads/main"), preparedSha);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("reuses an untagged prepared merge when ordinary publication is retried", async () => {
  const fixture = repositoryFixture();
  try {
    const input = mergeInput(fixture);
    let attempts = 0;
    await assert.rejects(
      squashMergeLocalPullRequest({
        ...input,
        publish: async () => {
          attempts += 1;
          throw new Error("publication interrupted");
        },
      }),
      /publication interrupted/,
    );

    const publication = await squashMergeLocalPullRequest({
      ...input,
      scan: async () => {
        throw new Error("a prepared ordinary merge must not be rebuilt or rescanned");
      },
      publish: async (request) => {
        attempts += 1;
        assert.equal(request.preparedTag, null);
        return {
          mergeCommitSha: request.mergeCommitSha,
          releaseTag: null,
          releaseUrl: null,
        };
      },
    });

    assert.equal(attempts, 2);
    assert.equal(publication.releaseTag, null);
    assert.equal(
      git(fixture.repoPath, "rev-parse", "refs/heads/main"),
      publication.mergeCommitSha,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("recovers idempotently when GitHub already points at the prepared merge", async () => {
  const fixture = repositoryFixture();
  try {
    const input = mergeInput(fixture);
    const preparedSha = await prepareInterruptedMerge(input);
    // publish は成功していたが、 ローカル状態の更新途中で落ちた回の再実行。 base は
    // 既に prepared まで進んでいるので、 prepared の親とは一致しない。
    git(fixture.repoPath, "merge", "--ff-only", preparedSha);

    const calls = [];
    const notices = [];
    const publication = await squashMergeLocalPullRequest({
      ...input,
      scan: async () => {
        throw new Error("a published prepared merge must not be rebuilt or rescanned");
      },
      readPublishedBase: async () => preparedSha,
      log: (message) => notices.push(message),
      publish: async (request) => {
        calls.push(request);
        return { mergeCommitSha: request.mergeCommitSha, releaseTag: null, releaseUrl: null };
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].mergeCommitSha, preparedSha);
    assert.equal(calls[0].expectedBaseSha, input.pullRequest.baseSha);
    assert.equal(publication.mergeCommitSha, preparedSha);
    assert.equal(git(fixture.repoPath, "rev-parse", "refs/heads/main"), preparedSha);
    assert.equal(refSha(fixture.repoPath, preparedRefName(input.pullRequest.id)), null);
    assert.match(notices.join("\n"), /already contains it/);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("recovers idempotently when GitHub carried the base beyond the prepared merge", async () => {
  const fixture = repositoryFixture();
  try {
    const input = mergeInput(fixture);
    const preparedSha = await prepareInterruptedMerge(input);
    git(fixture.repoPath, "merge", "--ff-only", preparedSha);
    // GitHub 側は publish の後さらに前進している (prepared は祖先として含まれる)。
    git(fixture.repoPath, "checkout", "-b", "published-later");
    writeFileSync(join(fixture.repoPath, "other.txt"), "other\npublished later\n", "utf8");
    git(fixture.repoPath, "add", "other.txt");
    git(fixture.repoPath, "commit", "-m", "published later");
    const publishedBaseSha = git(fixture.repoPath, "rev-parse", "HEAD");
    git(fixture.repoPath, "checkout", "main");
    git(fixture.repoPath, "merge", "--ff-only", publishedBaseSha);

    const calls = [];
    const publication = await squashMergeLocalPullRequest({
      ...input,
      scan: async () => {
        throw new Error("a published prepared merge must not be rebuilt or rescanned");
      },
      readPublishedBase: async () => publishedBaseSha,
      log: () => {},
      publish: async (request) => {
        calls.push(request);
        return { mergeCommitSha: request.mergeCommitSha, releaseTag: null, releaseUrl: null };
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].mergeCommitSha, preparedSha);
    assert.equal(publication.mergeCommitSha, preparedSha);
    assert.equal(git(fixture.repoPath, "rev-parse", "refs/heads/main"), publishedBaseSha);
    assert.equal(refSha(fixture.repoPath, preparedRefName(input.pullRequest.id)), null);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("discards an unpublished prepared merge left behind by a moved base", async () => {
  const fixture = repositoryFixture();
  try {
    const input = mergeInput(fixture);
    const preparedSha = await prepareInterruptedMerge(input);
    // 別の local PR が先に公開され、 ローカル base だけが前進した状態。 GitHub は
    // まだ prepared を知らない。
    writeFileSync(join(fixture.repoPath, "other.txt"), "other\nmoved\n", "utf8");
    git(fixture.repoPath, "add", "other.txt");
    git(fixture.repoPath, "commit", "-m", "another local PR landed first");
    const movedBaseSha = git(fixture.repoPath, "rev-parse", "refs/heads/main");

    const calls = [];
    const notices = [];
    const publication = await squashMergeLocalPullRequest({
      ...input,
      readPublishedBase: async () => input.pullRequest.baseSha,
      log: (message) => notices.push(message),
      publish: async (request) => {
        calls.push(request);
        return { mergeCommitSha: request.mergeCommitSha, releaseTag: null, releaseUrl: null };
      },
    });

    assert.equal(calls.length, 1);
    assert.notEqual(publication.mergeCommitSha, preparedSha);
    assert.equal(calls[0].expectedBaseSha, movedBaseSha);
    assert.equal(
      git(fixture.repoPath, "rev-parse", `${publication.mergeCommitSha}^`),
      movedBaseSha,
    );
    assert.equal(
      git(fixture.repoPath, "rev-parse", "refs/heads/main"),
      publication.mergeCommitSha,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("reports why a stale prepared merge was discarded", async () => {
  const fixture = repositoryFixture();
  try {
    const input = mergeInput(fixture);
    const preparedSha = await prepareInterruptedMerge(input);
    writeFileSync(join(fixture.repoPath, "other.txt"), "other\nmoved\n", "utf8");
    git(fixture.repoPath, "add", "other.txt");
    git(fixture.repoPath, "commit", "-m", "another local PR landed first");
    const movedBaseSha = git(fixture.repoPath, "rev-parse", "refs/heads/main");

    const notices = [];
    await squashMergeLocalPullRequest({
      ...input,
      readPublishedBase: async () => input.pullRequest.baseSha,
      log: (message) => notices.push(message),
      publish: async (request) => ({
        mergeCommitSha: request.mergeCommitSha,
        releaseTag: null,
        releaseUrl: null,
      }),
    });

    const reported = notices.join("\n");
    assert.match(reported, /discarded the stale prepared merge/);
    assert.match(reported, new RegExp(input.pullRequest.id));
    assert.match(reported, new RegExp(preparedSha));
    assert.match(reported, new RegExp(input.pullRequest.baseSha));
    assert.match(reported, new RegExp(movedBaseSha));
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("fails loudly instead of falling back when the rebuilt squash conflicts", async () => {
  const fixture = repositoryFixture();
  try {
    const input = mergeInput(fixture);
    const preparedSha = await prepareInterruptedMerge(input);
    // 先に入った変更が同じ行を書き換えたので、 現在の base の上では作り直せない。
    writeFileSync(join(fixture.repoPath, "product.txt"), "rewritten\n", "utf8");
    git(fixture.repoPath, "add", "product.txt");
    git(fixture.repoPath, "commit", "-m", "conflicting base change");
    const movedBaseSha = git(fixture.repoPath, "rev-parse", "refs/heads/main");

    await assert.rejects(
      squashMergeLocalPullRequest({
        ...input,
        readPublishedBase: async () => input.pullRequest.baseSha,
        log: () => {},
        publish: async () => {
          throw new Error("a stale prepared merge must never be published");
        },
      }),
      MergeConflictError,
    );

    assert.equal(git(fixture.repoPath, "rev-parse", "refs/heads/main"), movedBaseSha);
    assert.equal(refSha(fixture.repoPath, preparedRefName(input.pullRequest.id)), null);
    assert.ok(preparedSha);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("keeps the review when the head was only rebased (same patch content)", async () => {
  const fixture = repositoryFixture();
  try {
    const input = mergeInput(fixture);
    writeFileSync(join(fixture.repoPath, "other.txt"), "other\nmoved\n", "utf8");
    git(fixture.repoPath, "add", "other.txt");
    git(fixture.repoPath, "commit", "-m", "base moves");
    git(fixture.repoPath, "checkout", "feat/local");
    git(fixture.repoPath, "rebase", "main");
    git(fixture.repoPath, "checkout", "main");
    assert.notEqual(
      git(fixture.repoPath, "rev-parse", "refs/heads/feat/local"),
      input.pullRequest.reviewedHeadSha,
    );

    const mergeCommitSha = await squashMergeLocalPullRequest(input);

    assert.equal(git(fixture.repoPath, "rev-parse", "refs/heads/main"), mergeCommitSha);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("requires a new review when the head content changed after the review", async () => {
  const fixture = repositoryFixture();
  try {
    const input = mergeInput(fixture);
    git(fixture.repoPath, "checkout", "feat/local");
    writeFileSync(join(fixture.repoPath, "product.txt"), "base\nfeature\nunreviewed\n", "utf8");
    git(fixture.repoPath, "add", "product.txt");
    git(fixture.repoPath, "commit", "-m", "unreviewed change");
    git(fixture.repoPath, "checkout", "main");

    await assert.rejects(
      squashMergeLocalPullRequest(input),
      StaleReviewError,
    );
    assert.equal(
      git(fixture.repoPath, "rev-parse", "refs/heads/main"),
      input.pullRequest.baseSha,
    );
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});

test("reports a conflict with the advanced base as a merge conflict", async () => {
  const fixture = repositoryFixture();
  try {
    const input = mergeInput(fixture);
    // base 側が同じ行を書き換える → squash はコンフリクトする。
    writeFileSync(join(fixture.repoPath, "product.txt"), "rewritten\n", "utf8");
    git(fixture.repoPath, "add", "product.txt");
    git(fixture.repoPath, "commit", "-m", "conflicting base change");
    const movedBase = git(fixture.repoPath, "rev-parse", "refs/heads/main");

    await assert.rejects(
      squashMergeLocalPullRequest(input),
      MergeConflictError,
    );
    assert.equal(git(fixture.repoPath, "rev-parse", "refs/heads/main"), movedBase);
  } finally {
    rmSync(fixture.directory, { recursive: true, force: true });
  }
});
