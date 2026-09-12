import assert from "node:assert/strict";
import test from "node:test";
import { applySessionHookInjectionStrip, stripSessionHookInjection } from "../src/session-hook-env.mjs";

const SESSION_DIR = "C:\\Users\\raury\\AppData\\Local\\Temp\\concordia-session-hooks\\2d019dca515b9b08";

test("strips the injected core.hooksPath slot and the runner variables", () => {
  const { env, stripped } = stripSessionHookInjection({
    PATH: "x",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: SESSION_DIR,
    CONCORDIA_SESSION_HOOK_RUNNER: "E:\\Document\\Ars\\Concordia\\tools\\session-git-hook.mjs",
    CONCORDIA_SESSION_HOOK_CONFIG_INDEX: "0",
  });
  assert.equal(stripped, true);
  assert.deepEqual(env, { PATH: "x" });
});

test("keeps and renumbers unrelated GIT_CONFIG slots", () => {
  const { env } = stripSessionHookInjection({
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: "Authorization: Basic abc",
    GIT_CONFIG_KEY_1: "core.hooksPath",
    GIT_CONFIG_VALUE_1: SESSION_DIR,
    GIT_CONFIG_KEY_2: "user.name",
    GIT_CONFIG_VALUE_2: "LUDIARS Revisor",
  });
  assert.deepEqual(env, {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: "Authorization: Basic abc",
    GIT_CONFIG_KEY_1: "user.name",
    GIT_CONFIG_VALUE_1: "LUDIARS Revisor",
  });
});

test("leaves a user-provided core.hooksPath that is not a session directory", () => {
  const source = {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "C:/Users/raury/.git-hooks",
  };
  const { env, stripped } = stripSessionHookInjection(source);
  assert.equal(stripped, false);
  assert.equal(env, source);
});

test("ignores a malformed GIT_CONFIG_COUNT but still drops the runner variables", () => {
  const { env, stripped } = stripSessionHookInjection({ GIT_CONFIG_COUNT: "abc", CONCORDIA_SESSION_HOOK_RUNNER: "r" });
  assert.equal(stripped, true);
  assert.deepEqual(env, { GIT_CONFIG_COUNT: "abc" });
});

test("applySessionHookInjectionStrip mutates the target by deleting keys", () => {
  const target = {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: SESSION_DIR,
    GIT_CONFIG_KEY_1: "user.email",
    GIT_CONFIG_VALUE_1: "revisor@localhost",
    CONCORDIA_SESSION_HOOK_RUNNER: "r",
    OTHER: "keep",
  };
  assert.equal(applySessionHookInjectionStrip(target), true);
  assert.deepEqual(target, {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "user.email",
    GIT_CONFIG_VALUE_0: "revisor@localhost",
    OTHER: "keep",
  });
  assert.equal(applySessionHookInjectionStrip(target), false);
});
