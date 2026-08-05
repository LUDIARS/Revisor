import assert from "node:assert/strict";
import test from "node:test";
import { publishManualRelease } from "../src/manual-release.mjs";

test("publishes the current base as an immediate minor GitHub Release", async () => {
  const calls = [];
  let createdRelease;
  const result = await publishManualRelease({
    repository: {
      repository: "LUDIARS/Product",
      rootPath: "E:/Product",
      baseRef: "main",
    },
    kind: "minor",
    expectedVersion: "1.4.8",
    title: "Product 1.5",
    notes: "Upgrade guidance.",
    readCredentials: () => ({ appId: "1", privateKey: "unused" }),
    createClient: () => ({
      installationToken: async () => "installation-token",
      releaseByTag: async () => null,
      createRelease: async (_repository, release) => {
        createdRelease = release;
        return { html_url: "https://github.example/releases/v1.5.0" };
      },
    }),
    runGit: async (_rootPath, args) => args[0] === "symbolic-ref" ? "main" : "abc123",
    readVersion: async () => "1.4.8",
    writeVersion: async (_rootPath, tag) => calls.push(["write", tag]),
    getLocalTags: async () => ["v1.4.8"],
    getRemoteTags: async () => ["v1.4.8"],
    createTag: async (value) => calls.push(["tag", value.tag, value.mergeCommitSha]),
    push: async (value) => calls.push(["push", value.tag, value.mergeCommitSha]),
  });
  assert.equal(result.tag, "v1.5.0");
  assert.equal(result.version, "1.5.0");
  assert.deepEqual(calls, [
    ["tag", "v1.5.0", "abc123"],
    ["push", "v1.5.0", "abc123"],
    ["write", "v1.5.0"],
  ]);
  assert.equal(createdRelease.tag_name, "v1.5.0");
  assert.match(createdRelease.body, /Upgrade guidance/);
  assert.match(createdRelease.body, /compare\/v1\.4\.8\.\.\.v1\.5\.0/);
});

test("does not move local version when immediate publication fails", async () => {
  let wrote = false;
  await assert.rejects(
    publishManualRelease({
      repository: { repository: "LUDIARS/Product", rootPath: "E:/Product", baseRef: "main" },
      kind: "major",
      expectedVersion: "1.4.8",
      title: "Product 2",
      notes: "Breaking changes.",
      readCredentials: () => ({}),
      createClient: () => ({ installationToken: async () => "token" }),
      runGit: async (_rootPath, args) => args[0] === "symbolic-ref" ? "main" : "abc123",
      readVersion: async () => "1.4.8",
      writeVersion: async () => { wrote = true; },
      getLocalTags: async () => ["v1.4.8"],
      getRemoteTags: async () => [],
      createTag: async () => undefined,
      push: async () => { throw new Error("remote rejected"); },
    }),
    /remote rejected/,
  );
  assert.equal(wrote, false);
});

test("rejects a stale immediate release before creating remote state", async () => {
  let createdTag = false;
  await assert.rejects(
    publishManualRelease({
      repository: { repository: "LUDIARS/Product", rootPath: "E:/Product", baseRef: "main" },
      kind: "minor",
      expectedVersion: "1.4.8",
      title: "Product 1.5",
      notes: "Upgrade guidance.",
      runGit: async () => "main",
      readVersion: async () => "1.5.0",
      createTag: async () => { createdTag = true; },
    }),
    /Version changed from '1\.4\.8' to '1\.5\.0'/,
  );
  assert.equal(createdTag, false);
});
