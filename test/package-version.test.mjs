import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { syncPackageVersion } from "../src/package-version.mjs";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

/** package.json を 1 つ置き、 git 呼び出しを記録するだけの偽リポジトリ。 */
function fixture({ manifest, tracked = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "revisor-package-version-"));
  if (manifest !== null) writeFileSync(join(root, "package.json"), manifest, "utf8");
  const calls = [];
  const runGit = async (_cwd, args) => {
    calls.push(args);
    if (args[0] === "ls-files") return tracked ? "package.json" : "";
    return "";
  };
  return { root, calls, runGit };
}

const PRETTY = [
  "{",
  '  "name": "@ludiars/concordia",',
  '  "version": "0.1.0",',
  '  "type": "module",',
  '  "scripts": {',
  '    "build": "tsc -p tsconfig.json"',
  "  }",
  "}",
  "",
].join("\n");

test("writes the released version and commits only the manifest", async () => {
  const state = fixture({ manifest: PRETTY });
  try {
    const result = await syncPackageVersion({
      rootPath: state.root,
      version: "2.4.335",
      runGit: state.runGit,
    });
    assert.deepEqual(result, { synced: true, from: "0.1.0", to: "2.4.335" });
    const commit = state.calls.find((args) => args.includes("commit"));
    // 他の未コミット変更を巻き込まないよう、 対象を package.json 1 本に絞る。
    assert.ok(commit.includes("--only"));
    assert.equal(commit.at(-1), "package.json");
    assert.ok(commit.includes("--no-verify"));
  } finally {
    removeFixture(state.root);
  }
});

// JSON.parse → JSON.stringify で書き戻すと整形・キー順・末尾改行が丸ごと変わり、
// 1 語の追従が全面書き換えの diff になる。
test("changes only the version field and keeps the formatting", async () => {
  const state = fixture({ manifest: PRETTY });
  try {
    await syncPackageVersion({ rootPath: state.root, version: "2.4.335", runGit: state.runGit });
    assert.equal(
      readFileSync(join(state.root, "package.json"), "utf8"),
      PRETTY.replace('"version": "0.1.0"', '"version": "2.4.335"'),
    );
  } finally {
    removeFixture(state.root);
  }
});

test("does nothing when the manifest already carries the version", async () => {
  const state = fixture({ manifest: PRETTY.replace("0.1.0", "2.4.335") });
  try {
    const result = await syncPackageVersion({
      rootPath: state.root,
      version: "2.4.335",
      runGit: state.runGit,
    });
    assert.equal(result.synced, false);
    assert.equal(result.reason, "already current");
    assert.equal(state.calls.some((args) => args.includes("commit")), false);
  } finally {
    removeFixture(state.root);
  }
});

// package.json を持たないサービス (Unity / Rust など) がある。 追従できないことは
// 失敗ではなく理由として返し、 公開そのものを落とさない。
test("reports a missing manifest as a reason instead of failing", async () => {
  const state = fixture({ manifest: null });
  try {
    const result = await syncPackageVersion({
      rootPath: state.root,
      version: "1.0.0",
      runGit: state.runGit,
    });
    assert.deepEqual(result, { synced: false, reason: "no package.json" });
  } finally {
    removeFixture(state.root);
  }
});

// 未追跡の manifest を commit すると、 公開に無関係なファイルを base へ足してしまう。
test("refuses to commit an untracked manifest", async () => {
  const state = fixture({ manifest: PRETTY, tracked: false });
  try {
    const result = await syncPackageVersion({
      rootPath: state.root,
      version: "1.0.0",
      runGit: state.runGit,
    });
    assert.equal(result.synced, false);
    assert.match(result.reason, /not tracked/);
    assert.equal(readFileSync(join(state.root, "package.json"), "utf8"), PRETTY);
  } finally {
    removeFixture(state.root);
  }
});

test("reports an unreadable manifest as a reason", async () => {
  const state = fixture({ manifest: "{ not json" });
  try {
    const result = await syncPackageVersion({
      rootPath: state.root,
      version: "1.0.0",
      runGit: state.runGit,
    });
    assert.equal(result.synced, false);
    assert.match(result.reason, /not valid JSON/);
  } finally {
    removeFixture(state.root);
  }
});

test("reports a manifest without a version as a reason", async () => {
  const state = fixture({ manifest: '{\n  "name": "x"\n}\n' });
  try {
    const result = await syncPackageVersion({
      rootPath: state.root,
      version: "1.0.0",
      runGit: state.runGit,
    });
    assert.equal(result.synced, false);
    assert.match(result.reason, /declares no version/);
  } finally {
    removeFixture(state.root);
  }
});
