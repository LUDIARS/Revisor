import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedSourcePaths, containedFile, trackedSources } from "../src/praesidium/files.mjs";
import { scanRepository } from "../src/praesidium/scan.mjs";
import { collectionError, collectionErrorCode } from "../src/praesidium/collection-errors.mjs";

function repository(t) {
  const root = mkdtempSync(join(tmpdir(), "praesidium-files-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
  return root;
}

test("includes nonignored new sources so pre-commit autofix cannot evade the scan", (t) => {
  const root = repository(t);
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  writeFileSync(join(root, "new.js"), "eval(input);\n");
  mkdirSync(join(root, "node_modules"));
  writeFileSync(join(root, "node_modules", "ignored.js"), "eval(input);\n");
  assert.deepEqual(trackedSources(root).map(item => item.file), ["new.js"]);
});

test("rejects non-text, oversized and invalid UTF-8 sources rather than truncating", (t) => {
  const root = repository(t);
  const path = join(root, "source.js");
  for (const contents of [Buffer.from([0xff]), Buffer.from([0]), Buffer.alloc(2 * 1024 * 1024 + 1, 65)]) {
    writeFileSync(path, contents);
    assert.throws(() => trackedSources(root));
  }
  assert.throws(() => containedFile(root, root));
  assert.throws(() => containedFile(root, ".."));
});

test("collection failures expose only fixed codes and remain fail-closed", async (t) => {
  const root = repository(t);
  const path = join(root, "private-source.js");
  for (const [contents, reasonCode] of [
    [Buffer.from("private source\0"), "source.nul"],
    [Buffer.from([0xff]), "source.invalid-utf8"],
    [Buffer.alloc(2 * 1024 * 1024 + 1, 65), "source.size-limit"],
  ]) {
    writeFileSync(path, contents);
    const result = await scanRepository({ root, now: () => 0 });
    assert.deepEqual(result, { tool: "Praesidium", version: 1, status: "error",
      findings: [], checks: [], reason: "inspection incomplete: check repository files, limits and praesidium.json",
      reasonCode, durationMs: 0 });
    assert.ok(!JSON.stringify(result).includes(root));
    assert.ok(!JSON.stringify(result).includes("private"));
  }
});

test("unknown exceptions and forged codes stay redacted without reading their properties", async () => {
  const hostile = new Proxy({}, { get() { throw new Error("must not inspect exception"); } });
  for (const error of [new Error("non-text source: private source"),
    { code: "source.nul", reasonCode: "source.nul", message: "private source" }, hostile, null, undefined, "source.nul"]) {
    const result = await scanRepository({ root: ".", collect: () => { throw error; }, now: () => 0 });
    assert.deepEqual(result, { tool: "Praesidium", version: 1, status: "error", findings: [], checks: [],
      reason: "inspection incomplete: check repository files, limits and praesidium.json", durationMs: 0 });
  }
  for (const code of ["source.nul", "source.invalid-utf8", "source.size-limit", "source.file-count-limit"]) {
    const error = collectionError(code);
    error.message = "private source";
    assert.equal(collectionErrorCode(error), code);
    const result = await scanRepository({ root: ".", collect: () => { throw error; }, now: () => 0 });
    assert.equal(result.status, "error");
    assert.equal(result.reasonCode, code);
    assert.ok(!JSON.stringify(result).includes("private"));
  }
  assert.throws(() => collectionError("private source"), /unknown collection error code/);
});

test("accepts an escaped NUL in text without accepting raw NUL bytes", (t) => {
  const root = repository(t);
  const path = join(root, "key.js");
  const source = 'export const key = `${id}\\0${updatedAt}`;\n';
  writeFileSync(path, source);
  assert.deepEqual(trackedSources(root), [{ file: "key.js", source }]);
  writeFileSync(path, source.replace("\\0", "\0"));
  assert.throws(() => trackedSources(root), /non-text source/);
});

test("changed paths include added, modified and new files but never deletions", (t) => {
  const root = repository(t);
  const git = (...args) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args],
    { cwd: root, windowsHide: true, encoding: "utf8" }).trim();
  for (const file of ["kept.cpp", "edited.cpp", "removed.cpp"]) writeFileSync(join(root, file), "int f();\n");
  git("add", "--all");
  git("commit", "--quiet", "-m", "base");
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(root, "edited.cpp"), "int g();\n");
  rmSync(join(root, "removed.cpp"));
  writeFileSync(join(root, "added.cpp"), "int h();\n");
  git("add", "added.cpp");
  writeFileSync(join(root, "untracked.h"), "int i();\n");
  assert.deepEqual(changedSourcePaths(root, base).sort(), ["added.cpp", "edited.cpp", "untracked.h"]);
  assert.throws(() => changedSourcePaths(root, "--output=x"));
  assert.throws(() => changedSourcePaths(root, "missing-ref"));
});
