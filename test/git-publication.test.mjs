import assert from "node:assert/strict";
import test from "node:test";
import {
  pushPublishedCommit,
  pushReleaseAtomically,
} from "../src/git-publication.mjs";

const REMOTE_BASE = "1111111111111111111111111111111111111111";
const EXPECTED_BASE = "2222222222222222222222222222222222222222";
const MERGE_COMMIT = "3333333333333333333333333333333333333333";

function lsRemote({ baseSha = REMOTE_BASE, tagSha = null } = {}) {
  return [
    `${baseSha}\trefs/heads/main`,
    ...(tagSha ? [`${tagSha}\trefs/tags/v1.2.3^{}`] : []),
  ].join("\n");
}

test("publishes the reviewed base and release tag in one atomic push", async () => {
  const calls = [];
  const runRemoteGit = async (request) => {
    calls.push(request);
    return request.args[0] === "ls-remote" ? lsRemote() : "";
  };

  await pushReleaseAtomically({
    repository: "LUDIARS/Product",
    rootPath: "C:/Product",
    baseRef: "main",
    expectedBaseSha: EXPECTED_BASE,
    mergeCommitSha: MERGE_COMMIT,
    tag: "v1.2.3",
    token: "installation-token",
    runGit: async (_rootPath, args) => {
      if (args[2] === MERGE_COMMIT) return EXPECTED_BASE;
      assert.deepEqual(args, ["merge-base", REMOTE_BASE, EXPECTED_BASE]);
      return REMOTE_BASE;
    },
    runRemoteGit,
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].args, [
    "push",
    "--atomic",
    "https://github.com/LUDIARS/Product.git",
    `${MERGE_COMMIT}:refs/heads/main`,
    "refs/tags/v1.2.3:refs/tags/v1.2.3",
  ]);
  assert.doesNotMatch(calls[1].args.join(" "), /installation-token/);
});

test("publishes an ordinary merge without creating or pushing a tag", async () => {
  const calls = [];
  const runRemoteGit = async (request) => {
    calls.push(request);
    return request.args[0] === "ls-remote" ? lsRemote() : "";
  };

  await pushPublishedCommit({
    repository: "LUDIARS/Product",
    rootPath: "C:/Product",
    baseRef: "main",
    expectedBaseSha: EXPECTED_BASE,
    mergeCommitSha: MERGE_COMMIT,
    tag: null,
    token: "installation-token",
    runGit: async (_rootPath, args) => args[2] === MERGE_COMMIT
      ? EXPECTED_BASE
      : REMOTE_BASE,
    runRemoteGit,
  });

  assert.deepEqual(calls[0].args, [
    "ls-remote",
    "https://github.com/LUDIARS/Product.git",
    "refs/heads/main",
  ]);
  assert.deepEqual(calls[1].args, [
    "push",
    "https://github.com/LUDIARS/Product.git",
    `${MERGE_COMMIT}:refs/heads/main`,
  ]);
});

test("refuses to overwrite a base branch that moved independently", async () => {
  let pushed = false;
  await assert.rejects(
    pushReleaseAtomically({
      repository: "LUDIARS/Product",
      rootPath: "C:/Product",
      baseRef: "main",
      expectedBaseSha: EXPECTED_BASE,
      mergeCommitSha: MERGE_COMMIT,
      tag: "v1.2.3",
      token: "installation-token",
      runGit: async () => EXPECTED_BASE,
      runRemoteGit: async (request) => {
        if (request.args[0] === "push") pushed = true;
        return lsRemote();
      },
    }),
    /moved independently/,
  );
  assert.equal(pushed, false);
});

test("treats an already published base and tag as an idempotent success", async () => {
  let pushed = false;
  await pushReleaseAtomically({
    repository: "LUDIARS/Product",
    rootPath: "C:/Product",
    baseRef: "main",
    expectedBaseSha: EXPECTED_BASE,
    mergeCommitSha: MERGE_COMMIT,
    tag: "v1.2.3",
    token: "installation-token",
    runGit: async () => {
      throw new Error("merge-base is unnecessary when GitHub already has the merge commit");
    },
    runRemoteGit: async (request) => {
      if (request.args[0] === "push") pushed = true;
      return lsRemote({ baseSha: MERGE_COMMIT, tagSha: MERGE_COMMIT });
    },
  });
  assert.equal(pushed, false);
});

test("does not rewind a base branch that already contains the published merge", async () => {
  const calls = [];
  await pushPublishedCommit({
    repository: "LUDIARS/Product",
    rootPath: "C:/Product",
    baseRef: "main",
    expectedBaseSha: EXPECTED_BASE,
    mergeCommitSha: MERGE_COMMIT,
    tag: null,
    token: "installation-token",
    runGit: async (_rootPath, args) => {
      assert.deepEqual(args, ["merge-base", REMOTE_BASE, MERGE_COMMIT]);
      return MERGE_COMMIT;
    },
    runRemoteGit: async (request) => {
      calls.push(request);
      return lsRemote();
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].args[0], "ls-remote");
});

test("creates the base branch on the first publication into an empty repository", async () => {
  const calls = [];
  await pushReleaseAtomically({
    repository: "LUDIARS/Product",
    rootPath: "C:/Product",
    baseRef: "main",
    expectedBaseSha: EXPECTED_BASE,
    mergeCommitSha: MERGE_COMMIT,
    tag: "v0.3.0",
    token: "installation-token",
    runGit: async () => {
      throw new Error("An empty remote has nothing to compare against.");
    },
    runRemoteGit: async (request) => {
      calls.push(request);
      // Both the base lookup and the emptiness probe find no refs at all.
      return "";
    },
  });

  assert.equal(calls.length, 3);
  // The emptiness probe must list every ref: filtering it would read a
  // repository that merely lacks the base branch as empty.
  assert.deepEqual(calls[1].args, ["ls-remote", "https://github.com/LUDIARS/Product.git"]);
  assert.deepEqual(calls[2].args, [
    "push",
    "--atomic",
    "https://github.com/LUDIARS/Product.git",
    `${MERGE_COMMIT}:refs/heads/main`,
    "refs/tags/v0.3.0:refs/tags/v0.3.0",
  ]);
  assert.doesNotMatch(calls[2].args.join(" "), /installation-token/);
});

test("creates the base branch without --atomic when the first publication has no tag", async () => {
  const calls = [];
  await pushPublishedCommit({
    repository: "LUDIARS/Product",
    rootPath: "C:/Product",
    baseRef: "main",
    expectedBaseSha: EXPECTED_BASE,
    mergeCommitSha: MERGE_COMMIT,
    tag: null,
    token: "installation-token",
    runGit: async () => {
      throw new Error("An empty remote has nothing to compare against.");
    },
    runRemoteGit: async (request) => {
      calls.push(request);
      return "";
    },
  });

  assert.deepEqual(calls.at(-1).args, [
    "push",
    "https://github.com/LUDIARS/Product.git",
    `${MERGE_COMMIT}:refs/heads/main`,
  ]);
});

test("still refuses a missing base branch when the repository has other refs", async () => {
  await assert.rejects(
    pushPublishedCommit({
      repository: "LUDIARS/Product",
      rootPath: "C:/Product",
      baseRef: "main",
      expectedBaseSha: EXPECTED_BASE,
      mergeCommitSha: MERGE_COMMIT,
      tag: null,
      token: "installation-token",
      runGit: async () => {
        throw new Error("The publication must fail before comparing commits.");
      },
      runRemoteGit: async (request) => {
        assert.equal(request.args[0], "ls-remote");
        // No refs/heads/main, but the repository is not empty.
        return `${REMOTE_BASE}	refs/heads/legacy`;
      },
    }),
    /GitHub branch 'main' does not exist\./,
  );
});
