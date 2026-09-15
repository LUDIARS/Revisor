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

test("keeps a successful Release when its optional notification fails", async () => {
  let wrote = false;
  const result = await publishManualRelease({
    repository: { repository: "LUDIARS/Product", rootPath: "E:/Product", baseRef: "main", notify: { release: ["discord:release"] } },
    kind: "minor", expectedVersion: "1.4.8", title: "Product 1.5", notes: "Guidance.",
    readCredentials: () => ({}),
    createClient: () => ({ installationToken: async () => "token", releaseByTag: async () => null,
      createRelease: async () => ({ html_url: "https://github.example/releases/v1.5.0" }) }),
    runGit: async (_path, args) => args[0] === "symbolic-ref" ? "main" : "abc123",
    readVersion: async () => "1.4.8", writeVersion: async () => { wrote = true; },
    getLocalTags: async () => ["v1.4.8"], getRemoteTags: async () => ["v1.4.8"],
    createTag: async () => undefined, push: async () => undefined,
    notify: async () => { throw new Error("offline"); },
  });
  assert.equal(result.tag, "v1.5.0");
  assert.equal(wrote, true);
});

test("passes structured release fields alongside its human-readable notice", async () => {
  let notification;
  await publishManualRelease({
    repository: { repository: "LUDIARS/Product", rootPath: "E:/Product", baseRef: "main", notify: { release: ["concordia"] } },
    kind: "minor", expectedVersion: "1.4.8", title: "Product 1.5", notes: "Guidance.",
    readCredentials: () => ({}),
    createClient: () => ({ installationToken: async () => "token", releaseByTag: async () => null,
      createRelease: async () => ({ html_url: "https://github.example/releases/v1.5.0" }) }),
    runGit: async (_path, args) => args[0] === "symbolic-ref" ? "main" : "abc123",
    readVersion: async () => "1.4.8", writeVersion: async () => undefined,
    getLocalTags: async () => ["v1.4.8"], getRemoteTags: async () => ["v1.4.8"],
    createTag: async () => undefined, push: async () => undefined,
    notify: async (value) => { notification = value; },
  });
  assert.equal(notification.tag, "v1.5.0");
  assert.equal(notification.previousTag, "v1.4.8");
  assert.equal(notification.version, "1.5.0");
  assert.equal(notification.kind, "minor");
  assert.equal(notification.title, "Product 1.5");
  assert.match(notification.notice, /Guidance/);
  assert.equal(notification.releaseUrl, "https://github.example/releases/v1.5.0");
  assert.match(notification.publishedAt, /^\d{4}-\d{2}-\d{2}T/);
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

// package.json は版の正本ではないが追従はする。 tag を打つ前に commit しておくと、
// 公開が base と tag を atomic に push するのでツリーも origin も一致したままになる。
test("bumps package.json before tagging so the release carries it", async () => {
  const calls = [];
  let headMoved = false;
  const result = await publishManualRelease({
    repository: { repository: "LUDIARS/Product", rootPath: "E:/Product", baseRef: "main" },
    kind: "minor",
    expectedVersion: "1.4.8",
    title: "Product 1.5",
    notes: "Guidance.",
    readCredentials: () => ({}),
    createClient: () => ({
      installationToken: async () => "token",
      releaseByTag: async () => null,
      createRelease: async () => ({ html_url: "https://github.example/releases/v1.5.0" }),
    }),
    runGit: async (_path, args) => {
      if (args[0] === "symbolic-ref") return "main";
      return headMoved ? "bumped1" : "before1";
    },
    readVersion: async () => "1.4.8",
    writeVersion: async () => {},
    getLocalTags: async () => ["v1.4.8"],
    getRemoteTags: async () => ["v1.4.8"],
    syncPackage: async ({ version }) => {
      calls.push(["sync", version]);
      headMoved = true;
      return { synced: true, from: "1.4.8", to: version };
    },
    createTag: async (value) => calls.push(["tag", value.tag, value.mergeCommitSha]),
    push: async (value) => calls.push(["push", value.tag, value.mergeCommitSha]),
  });
  // 追従が先、 tag と push はその commit を指す。
  assert.deepEqual(calls, [
    ["sync", "1.5.0"],
    ["tag", "v1.5.0", "bumped1"],
    ["push", "v1.5.0", "bumped1"],
  ]);
  assert.deepEqual(result.packageVersionSync, { synced: true, from: "1.4.8", to: "1.5.0" });
});

// 公開していないのに版が上がった commit を base へ残さない。
test("rolls the package.json bump back when publication fails", async () => {
  const gitCalls = [];
  let headMoved = false;
  await assert.rejects(publishManualRelease({
    repository: { repository: "LUDIARS/Product", rootPath: "E:/Product", baseRef: "main" },
    kind: "minor",
    expectedVersion: "1.4.8",
    title: "Product 1.5",
    notes: "Guidance.",
    readCredentials: () => ({}),
    createClient: () => ({ installationToken: async () => "token" }),
    runGit: async (_path, args) => {
      gitCalls.push(args);
      if (args[0] === "symbolic-ref") return "main";
      if (args[0] === "reset") return "";
      return headMoved ? "bumped1" : "before1";
    },
    readVersion: async () => "1.4.8",
    writeVersion: async () => {},
    getLocalTags: async () => ["v1.4.8"],
    getRemoteTags: async () => ["v1.4.8"],
    syncPackage: async () => {
      headMoved = true;
      return { synced: true, from: "1.4.8", to: "1.5.0" };
    },
    createTag: async () => {},
    push: async () => { throw new Error("remote rejected"); },
  }), /remote rejected/);
  const reset = gitCalls.find((args) => args[0] === "reset");
  assert.deepEqual(reset, ["reset", "--hard", "before1"]);
});

// 追従しなかった公開では何も戻さない。
test("does not reset when there was no package.json to follow", async () => {
  const gitCalls = [];
  await assert.rejects(publishManualRelease({
    repository: { repository: "LUDIARS/Product", rootPath: "E:/Product", baseRef: "main" },
    kind: "minor",
    expectedVersion: "1.4.8",
    title: "Product 1.5",
    notes: "Guidance.",
    readCredentials: () => ({}),
    createClient: () => ({ installationToken: async () => "token" }),
    runGit: async (_path, args) => {
      gitCalls.push(args);
      return args[0] === "symbolic-ref" ? "main" : "abc123";
    },
    readVersion: async () => "1.4.8",
    writeVersion: async () => {},
    getLocalTags: async () => ["v1.4.8"],
    getRemoteTags: async () => ["v1.4.8"],
    syncPackage: async () => ({ synced: false, reason: "no package.json" }),
    createTag: async () => {},
    push: async () => { throw new Error("remote rejected"); },
  }), /remote rejected/);
  assert.equal(gitCalls.some((args) => args[0] === "reset"), false);
});

// GitHub Release は操作者が選べる。 作らない場合も tag と version は公開する。
test("publishes only the tag when the operator opts out of a GitHub Release", async () => {
  const calls = [];
  const result = await publishManualRelease({
    repository: { repository: "LUDIARS/Product", rootPath: "E:/Product", baseRef: "main" },
    kind: "minor", expectedVersion: "1.4.8", title: "Product 1.5", notes: "Guidance.",
    githubRelease: false,
    readCredentials: () => ({}),
    createClient: () => ({
      installationToken: async () => "token",
      releaseByTag: async () => { calls.push("releaseByTag"); return null; },
      createRelease: async () => { calls.push("createRelease"); return {}; },
    }),
    runGit: async (_path, args) => args[0] === "symbolic-ref" ? "main" : "abc123",
    readVersion: async () => "1.4.8",
    writeVersion: async (_path, tag) => calls.push(["write", tag]),
    getLocalTags: async () => ["v1.4.8"], getRemoteTags: async () => ["v1.4.8"],
    createTag: async (value) => calls.push(["tag", value.tag]),
    push: async (value) => calls.push(["push", value.tag]),
    notify: async () => undefined,
  });
  assert.deepEqual(calls, [["tag", "v1.5.0"], ["push", "v1.5.0"], ["write", "v1.5.0"]]);
  assert.equal(result.githubRelease, false);
  assert.equal(result.releaseUrl, null);
  assert.equal(result.workflow, "revisor");
});

// GitHub Workflow (MELPOT 等) は App を組み立てず、 登録 checkout の資格情報で tag を送る。
test("publishes a GitHub-workflow release by plain push without the App", async () => {
  const calls = [];
  const result = await publishManualRelease({
    repository: { repository: "MELPOT/Game", rootPath: "E:/Game", baseRef: "main", workflow: "github" },
    kind: "minor", expectedVersion: "0.8.0", title: "Game 0.9", notes: "Guidance.",
    readCredentials: () => { throw new Error("App credentials must not be read"); },
    createClient: () => { throw new Error("App client must not be created"); },
    runGit: async (_path, args) => args[0] === "symbolic-ref" ? "main" : "abc123",
    readVersion: async () => "0.8.0",
    writeVersion: async (_path, tag) => calls.push(["write", tag]),
    getLocalTags: async () => ["v0.8.0"],
    getRemoteTags: async () => { throw new Error("remote tags must not be queried"); },
    createTag: async (value) => calls.push(["tag", value.tag]),
    push: async () => { throw new Error("App push must not be used"); },
    pushPlain: async (value) => calls.push(["plain", value.tag, value.mergeCommitSha, value.registeredRootPath]),
    notify: async () => undefined,
  });
  assert.deepEqual(calls, [
    ["tag", "v0.9.0"],
    ["plain", "v0.9.0", "abc123", "E:/Game"],
    ["write", "v0.9.0"],
  ]);
  assert.equal(result.tag, "v0.9.0");
  assert.equal(result.githubRelease, false);
  assert.equal(result.workflow, "github");
});

test("refuses a GitHub Release for a GitHub-workflow repository before touching refs", async () => {
  let tagged = false;
  await assert.rejects(publishManualRelease({
    repository: { repository: "MELPOT/Game", rootPath: "E:/Game", baseRef: "main", workflow: "github" },
    kind: "minor", expectedVersion: "0.8.0", title: "Game 0.9", notes: "Guidance.",
    githubRelease: true,
    runGit: async () => "main",
    readVersion: async () => "0.8.0",
    createTag: async () => { tagged = true; },
  }), /GitHub Release cannot be created/);
  assert.equal(tagged, false);
});
