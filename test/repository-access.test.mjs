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

// The inspection opens the registered checkout, so it hits the same dubious-ownership
// refusal the merge path does. Without command-scoped trust every contaminated
// checkout is named at boot even though merging it works.
test("carries source trust into the readability check itself", async () => {
  // 登録パスは resolve してから区切りを / にそろえる。 ドライブ名付きの Windows パスは
  // POSIX (CI) では相対パスになり cwd が前に付くので、 ほかのホストでは同じ形の絶対パスを使う。
  const onWindows = process.platform === "win32";
  const rootPath = onWindows ? "C:\\workspace\\Revisor" : "/workspace/Revisor";
  const portableRoot = onWindows ? "C:/workspace/Revisor" : "/workspace/Revisor";
  const calls = [];
  await inspectRegisteredRepositories([{ ...REPOSITORIES[0], rootPath }], {
    runGit: (rootPath, args) => {
      calls.push(args);
      return `${rootPath}\\.git`;
    },
  });

  assert.deepEqual(calls[0].slice(0, 4), [
    "-c",
    `safe.directory=${portableRoot}`,
    "-c",
    `safe.directory=${portableRoot}/.git`,
  ]);
  assert.deepEqual(calls[0].slice(-2), ["rev-parse", "--absolute-git-dir"]);
  assert.equal(calls[0].includes("safe.directory=*"), false);
});

test("treats an empty registry as nothing to report", async () => {
  assert.deepEqual(await inspectRegisteredRepositories(undefined, { runGit }), []);
  assert.deepEqual(unreachableRepositories(undefined), []);
});
