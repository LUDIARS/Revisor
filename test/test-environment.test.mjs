import assert from "node:assert/strict";
import test from "node:test";
import { runRegisteredTests } from "../src/ci.mjs";
import { registeredTestEnvironment } from "../src/test-environment.mjs";

test("drops the settings that make npm skip devDependencies and keeps the rest", () => {
  const env = {
    PATH: "C:\bin",
    NODE_ENV: "production",
    npm_config_production: "true",
    NPM_CONFIG_OMIT: "dev optional",
    npm_config_only: "prod",
    npm_config_cache: "C:\cache",
  };
  assert.deepEqual(registeredTestEnvironment(env), { PATH: "C:\bin", npm_config_cache: "C:\cache" });
  assert.equal(env.NODE_ENV, "production", "the worker's own environment is not changed");
});

test("keeps a NODE_ENV other than production and an omit without dev", () => {
  assert.deepEqual(
    registeredTestEnvironment({ NODE_ENV: "test", npm_config_omit: "optional" }),
    { NODE_ENV: "test", npm_config_omit: "optional" },
  );
  assert.deepEqual(registeredTestEnvironment(undefined), {});
});

test("registered test cases run without the production setting so their preparation installs dev tools", async () => {
  const seen = [];
  await runRegisteredTests({
    worktreePath: process.cwd(),
    testCases: [{ name: "setup-build", command: "node", args: [], cwd: "." }],
    env: { PATH: "x", NODE_ENV: "production" },
    execute: async (spec) => { seen.push(spec.env); return { ok: true, exitCode: 0 }; },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].NODE_ENV, undefined);
  assert.equal(seen[0].PATH, "x");
});
