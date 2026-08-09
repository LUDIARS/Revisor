import assert from "node:assert/strict";
import test from "node:test";
import {
  formatRepositoryAccessFailure,
  inspectRegisteredRepositories,
  unreachableRepositories,
} from "../src/repository-access.mjs";

const REPOSITORIES = [
  { repository: "example/Revisor", rootPath: "C:\\workspace\\Revisor" },
  { repository: "example/Unreadable", rootPath: "C:\\workspace\\Unreadable" },
  { repository: "example/Moved" },
];

function runGit(rootPath) {
  if (rootPath.endsWith("Unreadable")) {
    throw new Error(
      "git rev-parse failed: fatal: detected dubious ownership in repository at\n"
      + "'C:/workspace/Unreadable/.git'\n'C:/workspace/Unreadable/.git' is owned by: other",
    );
  }
  return `${rootPath}\\.git`;
}

test("names every registered checkout Revisor cannot read", async () => {
  const results = await inspectRegisteredRepositories(REPOSITORIES, { runGit });
  const failures = unreachableRepositories(results);

  assert.equal(results.length, 3);
  assert.equal(results[0].ok, true);
  assert.deepEqual(failures.map((failure) => failure.repository), [
    "example/Unreadable",
    "example/Moved",
  ]);
  assert.match(failures[1].reason, /root_path is not registered/);
});

test("reports one failure per line with the ownership reason intact", async () => {
  const results = await inspectRegisteredRepositories(REPOSITORIES, { runGit });
  const line = formatRepositoryAccessFailure(unreachableRepositories(results)[0]);

  assert.equal(line.includes("\n"), false);
  assert.match(line, /example\/Unreadable at C:\\workspace\\Unreadable/);
  assert.match(line, /dubious ownership .* is owned by: other/);
});

test("treats an empty registry as nothing to report", async () => {
  assert.deepEqual(await inspectRegisteredRepositories(undefined, { runGit }), []);
  assert.deepEqual(unreachableRepositories(undefined), []);
});
