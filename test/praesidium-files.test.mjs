import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containedFile, trackedSources } from "../src/praesidium/files.mjs";

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
