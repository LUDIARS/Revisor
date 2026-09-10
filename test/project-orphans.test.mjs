import test from "node:test";
import assert from "node:assert/strict";
import { analyzeProjectOrphans } from "../src/project-orphans.mjs";
import { analyzePr } from "../src/anatomia.mjs";

test("uses the uncapped project count rather than the displayed orphan array", async () => {
  const result = await analyzeProjectOrphans({
    cliPath: "anatomia.mjs", cwd: "reviewed-head", env: { ANATOMIA_CACHE: "off" },
    run: async (options) => {
      assert.deepEqual(options.args, ["anatomia.mjs", "review", "--repo", "reviewed-head", "--json"]);
      assert.equal(options.cwd, "reviewed-head");
      assert.equal(options.env.ANATOMIA_CACHE, "off");
      return { ok: true, stdout: JSON.stringify({ summary: { orphans: 120 }, orphans: [] }) };
    },
  });
  assert.deepEqual(result, { status: "measured", scope: "project", count: 120 });
});

test("failed, missing and malformed counts stay unavailable instead of becoming healthy", async () => {
  for (const response of [
    { ok: false }, { ok: true, stdout: "invalid" }, { ok: true, stdout: "{}" },
    ...[-1, 1.5, "5"].map((orphans) => ({ ok: true, stdout: JSON.stringify({ summary: { orphans } }) })),
  ]) {
    const result = await analyzeProjectOrphans({ cliPath: "cli", cwd: "head", run: async () => response });
    assert.equal(result.status, "unavailable");
    assert.equal(result.count, undefined);
  }
});

test("head analysis preserves its gate evidence when the advisory project scan fails", async () => {
  const result = await analyzePr({
    cliPath: "cli", cwd: "head", base: "base", includeProjectOrphans: true,
    run: async ({ args }) => args[1] === "pr-review"
      ? { ok: true, stdout: JSON.stringify({ domain: { hasTargetDomain: true }, quality: { changedOrphans: [] } }) }
      : { ok: false, stderr: "private diagnostic" },
  });
  assert.equal(result.domain.hasTargetDomain, true);
  assert.deepEqual(result.quality.changedOrphans, []);
  assert.equal(result.quality.projectOrphans.status, "unavailable");
  assert.ok(!JSON.stringify(result).includes("private diagnostic"));
});
