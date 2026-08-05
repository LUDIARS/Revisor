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
  }]);
  assert.deepEqual(await service.initialize("LUDIARS/Product", "0.8.0"), {
    repository: "LUDIARS/Product",
    version: "0.8.0",
  });
  assert.deepEqual(initialized, [["E:/Product", "main", "0.8.0"]]);
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
