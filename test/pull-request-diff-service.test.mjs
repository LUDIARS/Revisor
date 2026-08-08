import assert from "node:assert/strict";
import test from "node:test";
import { PullRequestDiffService, parseChangedFiles } from "../src/pull-request-diff-service.mjs";

const PR = {
  id: "local-pr-1",
  repository: "LUDIARS/Revisor",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
};

test("parses normal and renamed changed-file records without C quoting", () => {
  assert.deepEqual(parseChangedFiles(
    "M\0src/日本語.mjs\0R100\0src/old.mjs\0src/new.mjs\0D\0deleted.txt\0",
  ), [
    { status: "modified", path: "src/日本語.mjs", previousPath: null },
    { status: "renamed", path: "src/new.mjs", previousPath: "src/old.mjs" },
    { status: "deleted", path: "deleted.txt", previousPath: null },
  ]);
});

test("reads only an immutable submitted PR comparison and rejects unrelated paths", async () => {
  const calls = [];
  const service = new PullRequestDiffService({
    getPullRequest: (id) => id === PR.id ? PR : null,
    getRepository: (repository) => repository === PR.repository ? { rootPath: "E:/repo" } : null,
    runGit: async (cwd, args) => {
      calls.push({ cwd, args });
      return args.includes("--name-status")
        ? "A\0src/new.mjs\0"
        : "diff --git a/src/new.mjs b/src/new.mjs\n+export const answer = 42;";
    },
  });

  const files = await service.files(PR.id);
  assert.deepEqual(files.files, [
    { status: "added", path: "src/new.mjs", previousPath: null },
  ]);
  const result = await service.fileDiff(PR.id, "src/new.mjs");
  assert.equal(result.file.status, "added");
  assert.match(result.diff, /answer = 42/);
  assert.equal(calls.at(-1).args.at(-1), "src/new.mjs");
  assert.equal(calls.filter(({ args }) => args.includes("--name-status")).length, 1);
  await assert.rejects(service.fileDiff(PR.id, "outside.txt"), /not part of this local PR/);
});
