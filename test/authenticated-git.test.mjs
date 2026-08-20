import assert from "node:assert/strict";
import test from "node:test";
import { runAuthenticatedGit } from "../src/authenticated-git.mjs";

test("branch transport does not acquire publication authorization", async () => {
  let request;
  await runAuthenticatedGit({
    cwd: "C:/Product",
    args: ["push", "https://github.com/LUDIARS/Product.git", "refs/heads/feature"],
    token: "test-token",
    env: { REVISOR_BRANCH_PUBLISHING: "1" },
    authorizedPublication: false,
    run: async (value) => {
      request = value;
      return { ok: true, stdout: "", stderr: "" };
    },
  });
  assert.equal(request.env.REVISOR_BRANCH_PUBLISHING, "1");
  assert.equal(request.env.REVISOR_PUBLISHING, undefined);
  assert.equal(request.env.ALLOW_MAIN_PUSH, undefined);
});

test("publication transport retains its base and tag authorization", async () => {
  let request;
  await runAuthenticatedGit({
    cwd: "C:/Product",
    args: ["push", "https://github.com/LUDIARS/Product.git", "refs/heads/main"],
    token: "test-token",
    env: {},
    run: async (value) => {
      request = value;
      return { ok: true, stdout: "", stderr: "" };
    },
  });
  assert.equal(request.env.REVISOR_PUBLISHING, "1");
  assert.equal(request.env.ALLOW_MAIN_PUSH, "1");
});
