import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTrustConfig,
  ensureTrustConfig,
  gitTrustEnv,
  resetTrustConfigCache,
  resolveTrustConfigPath,
  resolveUserGlobalConfigPath,
} from "../src/git-trust.mjs";

const WINDOWS_ENV = {
  LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
  USERPROFILE: "C:\\Users\\dev",
};

test("keeps the trust configuration beside the Revisor managed Git runtime", () => {
  assert.equal(
    resolveTrustConfigPath({ env: WINDOWS_ENV, platform: "win32" }).replaceAll("\\", "/"),
    "C:/Users/dev/AppData/Local/LUDIARS/Revisor/git-trust.gitconfig",
  );
  assert.equal(resolveTrustConfigPath({ env: {}, platform: "win32" }), null);
});

test("includes the user's global configuration so identity and credentials survive", () => {
  const content = buildTrustConfig("C:\\Users\\dev\\.gitconfig");
  assert.match(content, /\[include\]\n\tpath = "C:\/Users\/dev\/\.gitconfig"/);
  assert.match(content, /\[safe\]\n\tdirectory = \*/);
});

test("does not include a user configuration file that does not exist", () => {
  assert.equal(
    resolveUserGlobalConfigPath({
      env: { GIT_CONFIG_GLOBAL: "C:\\missing\\.gitconfig" },
      platform: "win32",
      fileExists: () => false,
    }),
    null,
  );
});

test("never includes the trust file into itself", () => {
  const trustConfigPath = "C:\\trust\\git-trust.gitconfig";
  assert.equal(
    resolveUserGlobalConfigPath({
      env: { GIT_CONFIG_GLOBAL: "C:/trust/git-trust.gitconfig" },
      platform: "win32",
      trustConfigPath,
      fileExists: () => true,
    }),
    null,
  );
  assert.equal(
    buildTrustConfig(null).includes("[include]"),
    false,
  );
});

test("points Git at the trust configuration without losing the caller's environment", () => {
  resetTrustConfigCache();
  const written = [];
  const env = gitTrustEnv({
    env: { ...WINDOWS_ENV, AUTH_HEADER: "secret" },
    platform: "win32",
    ensure: (path, content) => {
      written.push({ path, content });
      return path;
    },
  });

  assert.equal(written.length, 1);
  assert.match(written[0].content, /directory = \*/);
  assert.equal(
    env.GIT_CONFIG_GLOBAL.replaceAll("\\", "/"),
    "C:/Users/dev/AppData/Local/LUDIARS/Revisor/git-trust.gitconfig",
  );
  assert.equal(env.AUTH_HEADER, "secret");
});

test("runs Git unchanged when the trust configuration cannot be placed", () => {
  resetTrustConfigCache();
  const env = { LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" };
  const result = gitTrustEnv({
    env,
    platform: "win32",
    ensure: () => {
      throw new Error("read-only volume");
    },
  });
  assert.equal(result, env);
  assert.equal(resolveTrustConfigPath({ env: {}, platform: "linux" }), null);
});

test("writes the trust configuration only when its content changes", () => {
  resetTrustConfigCache();
  const writes = [];
  const files = new Map();
  const fileSystem = {
    readFile: (path) => {
      if (!files.has(path)) throw new Error("ENOENT");
      return files.get(path);
    },
    writeFile: (path, content) => {
      writes.push(path);
      files.set(path, content);
    },
    makeDirectory: () => {},
  };

  ensureTrustConfig("C:\\trust\\git-trust.gitconfig", "one", fileSystem);
  ensureTrustConfig("C:\\trust\\git-trust.gitconfig", "one", fileSystem);
  assert.equal(writes.length, 1);

  resetTrustConfigCache();
  ensureTrustConfig("C:\\trust\\git-trust.gitconfig", "one", fileSystem);
  assert.equal(writes.length, 1, "an unchanged file on disk is not rewritten");

  ensureTrustConfig("C:\\trust\\git-trust.gitconfig", "two", fileSystem);
  assert.equal(writes.length, 2);
});
