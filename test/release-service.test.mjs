import assert from "node:assert/strict";
import test from "node:test";
import { ReleaseService } from "../src/release-service.mjs";

test("projects registered before versioning stay visible and can be initialized", async () => {
  const repositories = [{
    repository: "LUDIARS/Product",
    rootPath: "E:/Product",
    baseRef: "main",
  }];
  const initialized = [];
  const service = new ReleaseService({
    store: {
      listRepositories: () => repositories,
      getRepository: () => repositories[0],
    },
    publicationCoordinator: { run: (operation) => operation() },
    inspectVersion: async () => ({ status: "missing", version: null, managed: false }),
    initializeVersion: async (...args) => {
      initialized.push(args);
      return "0.8.0";
    },
  });
  assert.deepEqual(await service.listProjects(), [{
    ...repositories[0],
    version: { status: "missing", version: null, managed: false },
    nextMajor: null,
    nextMinor: null,
    workflow: "revisor",
    githubReleaseAvailable: true,
  }]);
  assert.deepEqual(await service.initialize("LUDIARS/Product", "0.8.0"), {
    repository: "LUDIARS/Product",
    version: "0.8.0",
  });
  assert.equal(initialized.length, 1);
  assert.deepEqual(initialized[0].slice(0, 3), ["E:/Product", "main", "0.8.0"]);
  // 初期化コミットを merge repository の base へ届けるための口が渡っている。
  assert.equal(typeof initialized[0][3]?.onBootstrapCommitted, "function");
});

test("初期化コミットを積んだら merge repository の base を同じコミットへ進め、結果を返す", async () => {
  const repository = { repository: "LUDIARS/Product", rootPath: "E:/Product", baseRef: "main" };
  const advanced = [];
  const service = new ReleaseService({
    store: {
      path: "E:/state/revisor.sqlite",
      listRepositories: () => [repository],
      getRepository: () => repository,
    },
    publicationCoordinator: { run: (operation) => operation() },
    // 実物と同じく、 初期化コミットを作ったときだけコールバックを呼ぶ。
    initializeVersion: async (_rootPath, _baseRef, version, options) => {
      await options.onBootstrapCommitted({ parentSha: "a".repeat(40), bootstrapSha: "b".repeat(40) });
      return version;
    },
    advanceMergeBase: async (request) => {
      advanced.push(request);
      return { status: "advanced", mergeBaseSha: request.bootstrapSha };
    },
  });

  const result = await service.initialize("LUDIARS/Product", "0.8.0");

  assert.deepEqual(result, {
    repository: "LUDIARS/Product",
    version: "0.8.0",
    mergeBase: { status: "advanced", mergeBaseSha: "b".repeat(40) },
  });
  assert.deepEqual(advanced, [{
    repository,
    statePath: "E:/state/revisor.sqlite",
    baseRef: "main",
    parentSha: "a".repeat(40),
    bootstrapSha: "b".repeat(40),
  }]);
});

test("ready projects expose major and minor targets and publish through the coordinator", async () => {
  const repository = { repository: "LUDIARS/Product", rootPath: "E:/Product", baseRef: "main" };
  const published = [];
  const service = new ReleaseService({
    store: { listRepositories: () => [repository], getRepository: () => repository },
    publicationCoordinator: { run: (operation) => operation() },
    inspectVersion: async () => ({ status: "ready", version: "2.4.9", managed: true }),
    publish: async (value) => {
      published.push(value);
      return { tag: "v3.0.0" };
    },
    env: { TEST_ENV: "yes" },
  });
  const [project] = await service.listProjects();
  assert.equal(project.nextMajor, "3.0.0");
  assert.equal(project.nextMinor, "2.5.0");
  assert.deepEqual(
    await service.release("LUDIARS/Product", {
      kind: "major",
      expectedVersion: "2.4.9",
      title: "3.0",
      notes: "Notes",
    }),
    { tag: "v3.0.0" },
  );
  assert.equal(published[0].repository.repository, "LUDIARS/Product");
  assert.equal(published[0].env.TEST_ENV, "yes");
});

test("GitHub-workflow projects report that a GitHub Release is unavailable", async () => {
  const repository = { repository: "MELPOT/Game", rootPath: "E:/Game", baseRef: "main", workflow: "github" };
  const service = new ReleaseService({
    store: { listRepositories: () => [repository], getRepository: () => repository },
    publicationCoordinator: { run: (operation) => operation() },
    inspectVersion: async () => ({ status: "ready", version: "0.8.0", managed: true }),
  });
  const [project] = await service.listProjects();
  assert.equal(project.workflow, "github");
  assert.equal(project.githubReleaseAvailable, false);
});
