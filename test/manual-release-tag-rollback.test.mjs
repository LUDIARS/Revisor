import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalReleaseTag } from "../src/git-publication.mjs";
import { publishManualRelease } from "../src/manual-release.mjs";
import { git } from "../src/workspace.mjs";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

// A failed publication used to leave its freshly made tag on the abandoned
// version-bump commit, so the next release stopped with
// "Release tag 'v3.0.0' already points to another commit".

async function repositoryFixture({ withPackage = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "revisor-release-tag-rollback-"));
  const init = spawnSync("git", ["init", root], { encoding: "utf8", windowsHide: true });
  if (init.status !== 0) throw new Error(init.stderr || init.stdout);
  await git(root, ["checkout", "-q", "-b", "main"]);
  await git(root, ["config", "user.name", "Fixture"]);
  await git(root, ["config", "user.email", "fixture@localhost"]);
  await git(root, ["config", "commit.gpgsign", "false"]);
  await git(root, ["config", "tag.gpgsign", "false"]);
  if (withPackage) {
    writeFileSync(join(root, "package.json"), '{\n  "name": "product",\n  "version": "2.9.0"\n}\n', "utf8");
  } else {
    writeFileSync(join(root, "README.md"), "product\n", "utf8");
  }
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "initial"]);
  await git(root, ["tag", "-a", "v2.9.0", "-m", "v2.9.0"]);
  return root;
}

function releaseRequest(root, pushPlain) {
  return {
    repository: { repository: "MELPOT/Product", rootPath: root, baseRef: "main", workflow: "github" },
    kind: "major",
    expectedVersion: "2.9.0",
    title: "Product 3",
    notes: "Breaking changes.",
    readVersion: async () => "2.9.0",
    writeVersion: async () => { throw new Error("version must not move in this test"); },
    pushPlain,
    notify: async () => undefined,
  };
}

const tagTarget = (root, tag) => git(root, ["rev-list", "-n", "1", tag]);

test("createLocalReleaseTag reports whether it made the tag", async () => {
  const root = await repositoryFixture({ withPackage: false });
  try {
    const head = await git(root, ["rev-parse", "HEAD"]);
    const request = { rootPath: root, mergeCommitSha: head, tag: "v3.0.0", message: "v3.0.0" };
    assert.deepEqual(await createLocalReleaseTag(request), { created: true });
    assert.deepEqual(await createLocalReleaseTag(request), { created: false });
  } finally {
    removeFixture(root);
  }
});

test("a failed publication removes its own tag so the release can be retried", async () => {
  const root = await repositoryFixture();
  try {
    const before = await git(root, ["rev-parse", "HEAD"]);
    await assert.rejects(
      publishManualRelease(releaseRequest(root, async () => {
        throw new Error("push guard rejected the outgoing commits");
      })),
      /push guard rejected/,
    );
    assert.equal(await git(root, ["rev-parse", "HEAD"]), before);
    assert.equal(await git(root, ["tag", "--list", "v3.0.0"]), "");

    let published;
    const retry = releaseRequest(root, async (value) => { published = value; });
    retry.writeVersion = async () => undefined;
    const result = await publishManualRelease(retry);
    assert.equal(result.tag, "v3.0.0");
    assert.equal(published.tag, "v3.0.0");
    assert.equal(await tagTarget(root, "v3.0.0"), result.commitSha);
    assert.notEqual(result.commitSha, before);
  } finally {
    removeFixture(root);
  }
});

test("a failed publication leaves a tag it did not create untouched", async () => {
  const root = await repositoryFixture({ withPackage: false });
  try {
    const head = await git(root, ["rev-parse", "HEAD"]);
    await git(root, ["tag", "-a", "v3.0.0", head, "-m", "already there"]);
    await assert.rejects(
      publishManualRelease(releaseRequest(root, async () => {
        throw new Error("remote rejected");
      })),
      /remote rejected/,
    );
    assert.equal(await tagTarget(root, "v3.0.0"), head);
  } finally {
    removeFixture(root);
  }
});
