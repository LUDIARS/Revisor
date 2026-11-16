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

// 信頼設定は登録パスを resolve してから区切りを / にそろえる。 ドライブ名付きの Windows
// パスは POSIX (CI) では相対パスになり cwd が前に付くので、 Windows では従来どおりの綴りで
// 区切りの変換まで確かめ、 ほかのホストでは同じ形の絶対パスを使う。
const ON_WINDOWS = process.platform === "win32";
const USER_CONFIG = ON_WINDOWS ? "C:\\Users\\dev\\.gitconfig" : "/Users/dev/.gitconfig";
const PRODUCT = ON_WINDOWS ? "C:\\workspace\\Product" : "/workspace/Product";
const PRODUCT_GIT = ON_WINDOWS ? "C:\\workspace\\Product\\.git" : "/workspace/Product/.git";
const PREFIX = ON_WINDOWS ? "C:" : "";

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
  const content = buildTrustConfig(USER_CONFIG, [PRODUCT, PRODUCT_GIT]);
  assert.ok(content.includes(`[include]\n\tpath = "${PREFIX}/Users/dev/.gitconfig"`));
  assert.ok(content.includes(`directory = "${PREFIX}/workspace/Product"\n`));
  assert.ok(content.includes(`directory = "${PREFIX}/workspace/Product/.git"\n`));
  assert.equal(content.includes("directory = *"), false);
});

test("rejects control characters instead of emitting additional config lines", () => {
  assert.throws(
    () => buildTrustConfig(null, ["C:\\workspace\\Product\n[include]"]),
    /must not contain control characters/,
  );
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
  assert.equal(
    resolveUserGlobalConfigPath({
      env: { GIT_CONFIG_GLOBAL: "C:/trust/git-trust.gitconfig.0123456789abcdef" },
      platform: "win32",
      trustConfigPath,
      fileExists: () => true,
    }),
    null,
  );
});

test("points Git at the trust configuration without losing the caller's environment", () => {
  resetTrustConfigCache();
  const written = [];
  const env = gitTrustEnv({
    env: { ...WINDOWS_ENV, AUTH_HEADER: "secret" },
    platform: "win32",
    safeDirectories: [PRODUCT, PRODUCT_GIT],
    ensure: (path, content) => {
      written.push({ path, content });
      return path;
    },
  });

  assert.equal(written.length, 1);
  assert.ok(written[0].content.includes(`directory = "${PREFIX}/workspace/Product"\n`));
  assert.equal(written[0].content.includes("directory = *"), false);
  assert.match(
    env.GIT_CONFIG_GLOBAL.replaceAll("\\", "/"),
    /^C:\/Users\/dev\/AppData\/Local\/LUDIARS\/Revisor\/git-trust\.gitconfig\.[0-9a-f]{16}$/,
  );
  assert.equal(env.AUTH_HEADER, "secret");
});

test("runs Git unchanged when the trust configuration cannot be placed", () => {
  resetTrustConfigCache();
  const env = { LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" };
  const result = gitTrustEnv({
    env,
    platform: "win32",
    safeDirectories: ["C:\\workspace\\Product\\.git"],
    ensure: () => {
      throw new Error("read-only volume");
    },
  });
  assert.equal(result, env);
  assert.equal(resolveTrustConfigPath({ env: {}, platform: "linux" }), null);
});

test("does not replace the user's Git configuration for ordinary commands", () => {
  const env = { ...WINDOWS_ENV, GIT_CONFIG_GLOBAL: "C:\\Users\\dev\\custom.gitconfig" };
  assert.equal(gitTrustEnv({ env, platform: "win32" }), env);
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
