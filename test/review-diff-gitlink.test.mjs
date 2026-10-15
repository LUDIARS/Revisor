import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parseGitlinkPaths, readChangeProfile } from "../src/review-diff.mjs";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

function git(repoPath, ...args) {
  const result = spawnSync("git", ["-C", repoPath, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

const SHA_A = "1".repeat(40);
const SHA_B = "2".repeat(40);

test("reads submodule pointers from the raw diff mode, whatever the path looks like", () => {
  const raw = [
    `:160000 160000 ${SHA_A} ${SHA_B} M`, "lib/lapilli",
    `:100644 100644 ${SHA_A} ${SHA_B} M`, "src/a.mjs",
    `:000000 160000 ${"0".repeat(40)} ${SHA_A} A`, "vendor/new.json",
    `:160000 000000 ${SHA_A} ${"0".repeat(40)} D`, "vendor/old",
    "",
  ].join("\0");
  assert.deepEqual(parseGitlinkPaths(raw), ["lib/lapilli", "vendor/new.json", "vendor/old"]);
  assert.deepEqual(parseGitlinkPaths(""), []);
});

test("a change that only moves a submodule pointer is profiled as a dependency update", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "revisor-gitlink-"));
  t.after(() => removeFixture(directory));
  const repoPath = join(directory, "Product");
  git(directory, "init", "-b", "main", repoPath);
  writeFileSync(join(repoPath, "product.txt"), "base\n", "utf8");
  git(repoPath, "add", "--", "product.txt");
  git(repoPath, "update-index", "--add", "--cacheinfo", `160000,${SHA_A},lib/lapilli`);
  git(repoPath, "commit", "-m", "base");
  const base = git(repoPath, "rev-parse", "HEAD");
  git(repoPath, "update-index", "--cacheinfo", `160000,${SHA_B},lib/lapilli`);
  git(repoPath, "commit", "-m", "bump");

  const profile = await readChangeProfile(repoPath, base);
  assert.deepEqual(profile.changedPaths, ["lib/lapilli"]);
  assert.equal(profile.classification.dependencyOnly, true);
  assert.equal(profile.classification.codeDomainRequired, false);
});
