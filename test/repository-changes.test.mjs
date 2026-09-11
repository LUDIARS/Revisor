import assert from "node:assert/strict";
import test from "node:test";
import { collectRepositoryChanges } from "../src/repository-changes.mjs";

const GIT_LOG = "abcdef1234567890\tAdd release API\n";

test("collects commits, merged local PRs, Markdown, and a sanitized notice", async () => {
  const result = await collectRepositoryChanges({
    repository: { repository: "LUDIARS/Product", rootPath: "E:/Product", baseRef: "main" },
    from: "v1.0.0",
    to: "abcdef1234567890",
    store: { listPullRequests: () => [{
      repository: "LUDIARS/Product", status: "merged", number: 7, mergeCommitSha: "abcdef1234567890",
      title: "Ping @everyone <@123>", author: "owner", mergedAt: "2026-09-11T00:00:00Z",
    }] },
    runGit: async () => GIT_LOG,
    listTags: async () => ["v1.0.0"],
  });
  assert.equal(result.commits.length, 1);
  assert.equal(result.pullRequests[0].number, 7);
  assert.match(result.markdown, /Add release API/);
  assert.doesNotMatch(result.notice, /@everyone|<@123>/);
});

test("excludes merged local PRs whose merge commit is outside the range", async () => {
  const result = await collectRepositoryChanges({
    repository: { repository: "LUDIARS/Product", rootPath: "E:/Product", baseRef: "main" },
    from: "v1.0.0",
    to: "abcdef1234567890",
    store: { listPullRequests: () => [
      { repository: "LUDIARS/Product", status: "merged", number: 7, mergeCommitSha: "abcdef1234567890", title: "In range" },
      { repository: "LUDIARS/Product", status: "merged", number: 3, mergeCommitSha: "0000000000000000", title: "Older" },
      { repository: "LUDIARS/Product", status: "merged", number: 4, title: "No merge commit" },
      { repository: "LUDIARS/Other", status: "merged", number: 9, mergeCommitSha: "abcdef1234567890", title: "Other repo" },
    ] },
    runGit: async () => GIT_LOG,
    listTags: async () => ["v1.0.0"],
  });
  assert.deepEqual(result.pullRequests.map((pullRequest) => pullRequest.number), [7]);
});
