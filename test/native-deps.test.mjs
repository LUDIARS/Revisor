import test from "node:test";
import assert from "node:assert/strict";
import { cmakeDependencies } from "../src/native-deps/cmake-dependencies.mjs";
import {
  conanDependencies,
  parseGitmodules,
  submoduleDependencies,
  undeclaredVendored,
  vendoredDependencies,
} from "../src/native-deps/declared-dependencies.mjs";
import { changedDependencies, nativeInventory } from "../src/native-deps/inventory.mjs";
import { canonicalRepository, osvQuery, OSV_QUERYBATCH, queryOsv } from "../src/native-deps/osv.mjs";
import { NATIVE_DEPS_CHECK_NAME, runNativeDependencyCheck } from "../src/native-deps/run.mjs";
import { runNativeDependencyCheckedTests } from "../src/native-deps-ci.mjs";
import { commitSource, worktreeSource } from "../src/native-deps/tree-source.mjs";

const CMAKE = `
set(OPENXR_TAG "release-1.1.38")
# FetchContent_Declare(commented GIT_REPOSITORY https://example.com/x.git GIT_TAG v1)
FetchContent_Declare(
  glfw
  GIT_REPOSITORY https://github.com/glfw/glfw.git
  GIT_TAG        3.4
)
FetchContent_Declare(openxr GIT_REPOSITORY https://github.com/KhronosGroup/OpenXR-SDK.git GIT_TAG \${OPENXR_TAG})
FetchContent_Declare(mystery GIT_REPOSITORY https://github.com/a/b.git GIT_TAG \${FROM_ELSEWHERE})
ExternalProject_Add(zlib URL https://zlib.net/zlib-1.3.1.tar.gz)
FetchContent_Declare(floating GIT_REPOSITORY https://github.com/a/floating.git)
`;

test("CMake declarations become records; variables resolve only from the same file", () => {
  assert.deepEqual(cmakeDependencies("CMakeLists.txt", CMAKE), [
    { kind: "cmake", name: "glfw", file: "CMakeLists.txt", repository: "https://github.com/glfw/glfw.git", revision: "3.4" },
    { kind: "cmake", name: "openxr", file: "CMakeLists.txt", repository: "https://github.com/KhronosGroup/OpenXR-SDK.git", revision: "release-1.1.38" },
    { kind: "cmake", name: "mystery", file: "CMakeLists.txt", repository: "https://github.com/a/b.git", unresolved: "a ${VAR} in the declaration is not set in the same file" },
    { kind: "cmake", name: "zlib", file: "CMakeLists.txt", url: "https://zlib.net/zlib-1.3.1.tar.gz" },
    { kind: "cmake", name: "floating", file: "CMakeLists.txt", repository: "https://github.com/a/floating.git", unresolved: "GIT_REPOSITORY without a pinned GIT_TAG" },
  ]);
});

test("submodules pin their gitlink commit; Conan and vendored declarations parse strictly", () => {
  const gitmodules = '[submodule "lib/gtest"]\n\tpath = third_party/gtest\n\turl = https://github.com/google/googletest.git\n';
  assert.deepEqual(parseGitmodules(gitmodules), [{ path: "third_party/gtest", url: "https://github.com/google/googletest.git" }]);
  const sha = "a".repeat(40);
  assert.deepEqual(submoduleDependencies(gitmodules, new Map([["third_party/gtest", sha]])), [
    { kind: "submodule", name: "third_party/gtest", file: ".gitmodules", repository: "https://github.com/google/googletest.git", revision: sha },
  ]);
  assert.match(submoduleDependencies(gitmodules, new Map())[0].unresolved, /no gitlink/);

  assert.deepEqual(conanDependencies("conanfile.txt", "[requires]\nzlib/1.3.1\nfmt/10.2.1@user/stable\n[generators]\nCMakeDeps\n")
    .map((d) => `${d.name}/${d.version}`), ["zlib/1.3.1", "fmt/10.2.1"]);
  assert.deepEqual(conanDependencies("conan.lock", JSON.stringify({ requires: ["openssl/3.2.1#abc%1"] })).map((d) => d.version), ["3.2.1"]);
  assert.deepEqual(conanDependencies("conanfile.py", 'def requirements(self):\n    self.requires("boost/1.84.0")\n').map((d) => d.name), ["boost"]);

  assert.deepEqual(vendoredDependencies(JSON.stringify({ version: 1, vendored: [{ path: "third_party/stb/", repository: "https://github.com/nothings/stb", revision: "f75e8d1" }] })), [
    { kind: "vendored", name: "third_party/stb", file: "revisor.native-deps.json", repository: "https://github.com/nothings/stb", revision: "f75e8d1" },
  ]);
  assert.match(vendoredDependencies("{").at(0).unresolved, /not valid JSON/);
  assert.match(vendoredDependencies(JSON.stringify({ version: 1, vendored: [{ path: "x" }] })).at(0).unresolved, /path, repository and revision/);
});

test("vendored copies without a declaration are reported, build glue is not", () => {
  const files = ["third_party/stb/stb_image.h", "third_party/stb_truetype.h", "third_party/CMakeLists.txt", "third_party/.clang-format",
    "third_party/gtest/x.h", "vendor/some-npm-package-1.0.0.tgz", "vendor/docs/README.md", "src/a.cpp"];
  assert.deepEqual(undeclaredVendored(files, new Set(["third_party/gtest"])).map((d) => d.name), ["third_party/stb", "third_party/stb_truetype.h"]);
});

function fakeSource(files, gitlinks = new Map()) {
  return {
    files: async () => Object.keys(files),
    read: async (path) => files[path],
    gitlinks: async () => gitlinks,
  };
}

test("only C/C++ repositories have an inventory; changes are new keys or new pins", async () => {
  assert.equal(await nativeInventory(fakeSource({ "index.js": "", ".gitmodules": "" })), null);
  const base = await nativeInventory(fakeSource({ "a.cpp": "", "CMakeLists.txt": "FetchContent_Declare(glfw GIT_REPOSITORY https://github.com/glfw/glfw.git GIT_TAG 3.3.8)" }));
  const head = await nativeInventory(fakeSource({
    "a.cpp": "",
    "CMakeLists.txt": "FetchContent_Declare(glfw GIT_REPOSITORY https://github.com/glfw/glfw.git GIT_TAG 3.4)\nFetchContent_Declare(fmt GIT_REPOSITORY https://github.com/fmtlib/fmt GIT_TAG 10.2.1)",
  }));
  assert.deepEqual(changedDependencies(head, base).map((d) => `${d.name}@${d.revision}`), ["glfw@3.4", "fmt@10.2.1"]);
  assert.deepEqual(changedDependencies(head, head), []);
});

test("OSV queries carry only library identities", () => {
  assert.equal(canonicalRepository("https://GitHub.com/glfw/glfw.git/"), "https://github.com/glfw/glfw");
  assert.equal(canonicalRepository("git@github.com:google/googletest.git"), "https://github.com/google/googletest");
  const sha = "B".repeat(40);
  assert.deepEqual(osvQuery({ kind: "submodule", name: "x", repository: "https://h/o/r", revision: sha }), { commit: sha.toLowerCase() });
  assert.deepEqual(osvQuery({ kind: "cmake", name: "glfw", repository: "https://github.com/glfw/glfw.git", revision: "3.4" }),
    { package: { name: "https://github.com/glfw/glfw", ecosystem: "GIT" }, version: "3.4" });
  assert.deepEqual(osvQuery({ kind: "conan", name: "zlib", version: "1.2.11" }), { package: { name: "zlib", ecosystem: "ConanCenter" }, version: "1.2.11" });
  assert.equal(osvQuery({ kind: "cmake", name: "zlib", url: "https://zlib.net/zlib-1.3.1.tar.gz" }), null);
  assert.equal(osvQuery({ kind: "cmake", name: "m", unresolved: "x" }), null);
});

test("queryOsv batches, keeps order and fails loudly on a malformed answer", async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push([url, JSON.parse(init.body)]);
    const { queries } = JSON.parse(init.body);
    return { ok: true, json: async () => ({ results: queries.map((q) => (q.commit ? { vulns: [{ id: "CVE-2" }, { id: "CVE-1" }] } : {})) }) };
  };
  assert.deepEqual(await queryOsv([{ commit: "a" }, { package: { name: "p", ecosystem: "GIT" }, version: "1" }], { fetchImpl }), [["CVE-1", "CVE-2"], []]);
  assert.equal(sent[0][0], OSV_QUERYBATCH);
  await assert.rejects(queryOsv([{ commit: "a" }], { fetchImpl: async () => ({ ok: true, json: async () => ({ results: [] }) }) }));
  await assert.rejects(queryOsv([{ commit: "a" }], { fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) }));
});

const BASE_FILES = {
  "src/a.cpp": "",
  "CMakeLists.txt": "FetchContent_Declare(glfw GIT_REPOSITORY https://github.com/glfw/glfw.git GIT_TAG 3.3.8)\nFetchContent_Declare(old GIT_REPOSITORY https://github.com/a/old GIT_TAG 1.0)",
};
const HEAD_FILES = {
  ...BASE_FILES,
  "CMakeLists.txt": `${BASE_FILES["CMakeLists.txt"].replace("3.3.8", "3.4")}\nFetchContent_Declare(fresh GIT_REPOSITORY https://github.com/a/fresh GIT_TAG \${UNSET})`,
};

function deps({ head = HEAD_FILES, base = BASE_FILES, vulnerable = {}, query } = {}) {
  return {
    headSource: () => fakeSource(head),
    baseSource: () => fakeSource(base),
    now: () => 0,
    query: query ?? (async (queries) => queries.map((q) => vulnerable[q.package?.name] ?? [])),
  };
}

const options = { worktreePath: "/wt", mergeBase: "abc123" };

test("a vulnerable or unidentifiable changed dependency fails; existing debt is advisory", async () => {
  const result = await runNativeDependencyCheck(options, deps({
    vulnerable: { "https://github.com/glfw/glfw": ["CVE-2024-1"], "https://github.com/a/old": ["CVE-2010-9"] },
  }));
  assert.equal(result.name, NATIVE_DEPS_CHECK_NAME);
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.nativeDependencies, {
    total: 3, changed: 2, queried: 2, blockingVulnerable: 1, blockingUnidentified: 1, existingVulnerable: 1, unverified: 0,
  });
  assert.deepEqual(result.output.text.split("\n"), [
    "blocking: cmake:glfw@3.4 (CMakeLists.txt): CVE-2024-1",
    "blocking: cmake:fresh (CMakeLists.txt): cannot identify (a ${VAR} in the declaration is not set in the same file)",
    "existing: cmake:old@1.0 (CMakeLists.txt): CVE-2010-9",
  ]);
});

test("unchanged vulnerable dependencies pass with the advisory listed", async () => {
  const result = await runNativeDependencyCheck(options, deps({ head: BASE_FILES, vulnerable: { "https://github.com/a/old": ["CVE-2010-9"] } }));
  assert.equal(result.status, "passed");
  assert.match(result.output.text, /^existing: cmake:old@1\.0/);
});

test("OSV unreachable: error when the PR changed queryable dependencies, stated skip otherwise", async () => {
  const down = async () => { throw new Error("network"); };
  assert.equal((await runNativeDependencyCheck(options, deps({ query: down }))).status, "error");
  const skipped = await runNativeDependencyCheck(options, deps({ head: BASE_FILES, query: down }));
  assert.equal(skipped.status, "skipped");
  assert.match(skipped.reason, /changed no queryable/);
});

test("git failures error; non-native repositories add no row; no merge base treats all as changed", async () => {
  const broken = { ...deps(), headSource: () => ({ files: async () => { throw new Error("git"); } }) };
  assert.equal((await runNativeDependencyCheck(options, broken)).status, "error");
  assert.equal(await runNativeDependencyCheck(options, deps({ head: { "a.js": "" }, base: { "a.js": "" } })), null);
  const noBase = await runNativeDependencyCheck({ worktreePath: "/wt" }, deps({ head: BASE_FILES }));
  assert.equal(noBase.nativeDependencies.changed, 2);
});

test("the dependency row precedes the registered tests and does not stop them", async () => {
  const events = [];
  const outcomes = await runNativeDependencyCheckedTests({ onCheckResult: async (check) => events.push(check.name) }, {
    check: async () => ({ name: NATIVE_DEPS_CHECK_NAME, status: "failed" }),
    runTests: async () => { events.push("tests"); return [{ name: "unit", status: "passed" }]; },
  });
  assert.deepEqual(events, [NATIVE_DEPS_CHECK_NAME, "tests"]);
  assert.deepEqual(outcomes.map((o) => o.name), [NATIVE_DEPS_CHECK_NAME, "unit"]);
  const none = await runNativeDependencyCheckedTests({}, { check: async () => null, runTests: async () => [{ name: "unit", status: "passed" }] });
  assert.deepEqual(none.map((o) => o.name), ["unit"]);
});

test("worktree and commit sources read files, text and gitlinks through git", async () => {
  const sha = "c".repeat(40);
  const calls = [];
  const run = async ({ args, cwd }) => {
    calls.push([cwd, ...args]);
    if (args[0] === "ls-files" && args.includes("--stage")) {
      return { ok: true, stdout: `100644 ${"d".repeat(40)} 0\tsrc/a.cpp\x00160000 ${sha} 0\tthird_party/gtest\0` };
    }
    if (args[0] === "ls-files") return { ok: true, stdout: "src/a.cpp\0new.hpp\0" };
    if (args[0] === "ls-tree" && args.includes("--name-only")) return { ok: true, stdout: "src/a.cpp\0" };
    if (args[0] === "ls-tree") return { ok: true, stdout: `100644 blob ${"d".repeat(40)}\tsrc/a.cpp\x00160000 commit ${sha}\tthird_party/gtest\0` };
    if (args[0] === "show") return { ok: true, stdout: "base text" };
    return { ok: false, stdout: "" };
  };
  const head = worktreeSource("/wt", { run });
  assert.deepEqual(await head.files(), ["src/a.cpp", "new.hpp"]);
  assert.deepEqual([...await head.gitlinks()], [["third_party/gtest", sha]]);
  const base = commitSource("/wt", "abc123", { run });
  assert.deepEqual(await base.files(), ["src/a.cpp"]);
  assert.equal(await base.read("CMakeLists.txt"), "base text");
  assert.deepEqual([...await base.gitlinks()], [["third_party/gtest", sha]]);
  assert.deepEqual(calls.find((call) => call[1] === "show"), ["/wt", "show", "abc123:CMakeLists.txt"]);
  assert.throws(() => commitSource("/wt", "--upload-pack=x", { run }), /commit ref required/);
  await assert.rejects(worktreeSource("/wt", { run: async () => ({ ok: false, stdout: "" }) }).files(), /git ls-files failed/);
});
