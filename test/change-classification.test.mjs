import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyChange,
  classifyPath,
  diffLineStats,
  isDependencyOnlyChange,
  isDocsOnlyChange,
  isDocsOrConfigOnlyChange,
} from "../src/change-classification.mjs";

test("classifies a path by the cost decision it drives, not by extension alone", () => {
  assert.equal(classifyPath("package-lock.json"), "generated");
  assert.equal(classifyPath("dist/server.js"), "generated");
  assert.equal(classifyPath("test/ci.test.mjs"), "test");
  assert.equal(classifyPath("src/runner.test.mjs"), "test");
  assert.equal(classifyPath("spec/architecture.md"), "docs");
  assert.equal(classifyPath(".github/workflows/ci.yml"), "infra");
  assert.equal(classifyPath("migrations/030_add_column.sql"), "infra");
  assert.equal(classifyPath("package.json"), "config");
  assert.equal(classifyPath("tsconfig.build.json"), "config");
  assert.equal(classifyPath("spec-index.jsonl"), "config");
  assert.equal(classifyPath("assets/logo.png"), "asset");
  assert.equal(classifyPath("src/runner.mjs"), "code");
});

test("declarative spec and Anatomia files are docs, not executable config (Memoria #1221)", () => {
  assert.equal(classifyPath("spec/domains/review-gate.domain.json"), "docs");
  assert.equal(classifyPath("spec/data/ontology/core.json"), "docs");
  assert.equal(classifyPath("spec/index.jsonl"), "docs");
  assert.equal(classifyPath(".anatomia/layers.json"), "docs");
  assert.equal(classifyPath(".anatomia/domains/core.domain.json"), "docs");
  assert.equal(classifyPath("packages/api/spec/test-plan.yaml"), "docs");
  // Executable defs and scripts under spec/ still run code.
  assert.equal(classifyPath(".anatomia/domains/core.domain.mjs"), "code");
  assert.equal(classifyPath("spec/scripts/check.mjs"), "code");
  // A domain-declaration-only change carries no executable kind.
  const profile = classifyChange({
    changedPaths: ["packages/ui/spec/a.domain.yaml", ".anatomia/layers.json"],
  });
  assert.deepEqual(profile.kinds, ["docs"]);
  assert.equal(profile.docsOnly, true);
  assert.equal(profile.docsOrConfigOnly, true);
  assert.equal(profile.codeDomainRequired, false);
  assert.deepEqual(profile.runtimeSurfaces, []);
});

test("counts only diff body lines", () => {
  const diff = [
    "diff --git a/src/a.mjs b/src/a.mjs",
    "--- a/src/a.mjs",
    "+++ b/src/a.mjs",
    "@@ -1,2 +1,3 @@",
    " keep",
    "+added",
    "+added again",
    "-removed",
  ].join("\n");
  assert.deepEqual(diffLineStats(diff), { added: 2, removed: 1, changedLines: 3 });
});

test("counts a removed Markdown rule instead of reading it as a file header", () => {
  const diff = [
    "diff --git a/spec/a.md b/spec/a.md",
    "--- a/spec/a.md",
    "+++ b/spec/a.md",
    "@@ -1,3 +1,2 @@",
    "----",
    "-updated: 2026-07-29",
    "+++text",
  ].join("\n");
  assert.deepEqual(diffLineStats(diff), { added: 1, removed: 2, changedLines: 3 });
});

// 依存だけの変更は「実行コードあり / なし」のどちらでもない。 ソースは動いて
// いないが、脆弱性診断と登録テストは最も要る場面。
test("treats a change as dependency-only only when every path is a dependency manifest", () => {
  assert.equal(isDependencyOnlyChange(["package.json", "package-lock.json"]), true);
  assert.equal(isDependencyOnlyChange(["pnpm-lock.yaml"]), true);
  assert.equal(isDependencyOnlyChange(["Cargo.toml", "Cargo.lock"]), true);
  assert.equal(isDependencyOnlyChange(["server/package.json", "web/pnpm-lock.yaml"]), true);
  // 1 ファイルでもソースが混ざれば通常の実装変更として扱う。
  assert.equal(isDependencyOnlyChange(["package.json", "src/runner.mjs"]), false);
  assert.equal(isDependencyOnlyChange(["package.json", "README.md"]), false);
  assert.equal(isDependencyOnlyChange([]), false);
  assert.equal(classifyChange({ changedPaths: ["package.json", "package-lock.json"] }).dependencyOnly, true);
  assert.equal(classifyChange({ changedPaths: ["src/a.ts"] }).dependencyOnly, false);
});

// submodule の参照だけを進める変更は依存の更新。 拡張子の無いパスが code と
// 分類され、 対象ドメインが決まらず動作ブロックが必ず落ちていた (Praeforma#25)。
test("treats a submodule pointer as a dependency update, not as code", () => {
  const profile = classifyChange({ changedPaths: ["lib/lapilli"], gitlinkPaths: ["lib/lapilli"] });
  assert.deepEqual(profile.kinds, ["config"]);
  assert.equal(profile.dependencyOnly, true);
  assert.equal(profile.codeDomainRequired, false);
  assert.equal(profile.docsOrConfigOnly, false);
  assert.deepEqual(profile.runtimeSurfaces, []);
  assert.equal(isDependencyOnlyChange(["lib/lapilli", "package.json"], ["lib/lapilli"]), true);
  // gitlink と分からなければ従来どおり code。
  assert.equal(classifyChange({ changedPaths: ["lib/lapilli"] }).codeDomainRequired, true);
  // ソースが混ざれば通常の実装変更としてドメインを要求する。
  const mixed = classifyChange({ changedPaths: ["lib/lapilli", "src/a.mjs"], gitlinkPaths: ["lib/lapilli"] });
  assert.equal(mixed.dependencyOnly, false);
  assert.equal(mixed.codeDomainRequired, true);
});

test("treats a change as docs-only only when every path is documentation", () => {
  assert.equal(isDocsOnlyChange(["README.md", "spec/architecture.md"]), true);
  assert.equal(isDocsOnlyChange(["README.md", "src/runner.mjs"]), false);
  assert.equal(isDocsOnlyChange([]), false);
});

test("treats a change as docs/config-only when no path is code", () => {
  assert.equal(isDocsOrConfigOnlyChange(["excubitor.catalog.yaml"]), true);
  assert.equal(isDocsOrConfigOnlyChange(["tsconfig.json", "config/app.toml"]), true);
  assert.equal(isDocsOrConfigOnlyChange(["README.md", "excubitor.catalog.yaml"]), true);
  assert.equal(isDocsOrConfigOnlyChange([".env.example", ".gitignore", ".npmrc"]), true);
  assert.equal(isDocsOrConfigOnlyChange(["README.md"]), true);
  // JSON Lines は JSON と同じ宣言的データ。 .json$ 固定で漏れており、 生成物 *.jsonl の
  // 追跡をやめる変更が「コード」と分類されてドメインを要求され、 通せなくなっていた。
  assert.equal(isDocsOrConfigOnlyChange([".gitignore", "spec-index.jsonl"]), true);
  assert.equal(isDocsOrConfigOnlyChange(["README.md", "data/index.jsonl"]), true);
  assert.equal(isDocsOrConfigOnlyChange(["app.yaml", "src/runner.mjs"]), false);
  assert.equal(isDocsOrConfigOnlyChange(["scripts/deploy.ps1"]), false);
  assert.equal(isDocsOrConfigOnlyChange([]), false);
});

test("a dependency manifest keeps the target-domain gate even though it looks like config", () => {
  // Editing these pulls third-party code into the build, so the relaxation must
  // not cover them (neco 2026-07-30). The list is the one review-gate.md names.
  for (const path of [
    "package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "pnpm-lock.yml",
    "Cargo.toml", "Cargo.lock", "pyproject.toml", "poetry.lock", "Gemfile", "Gemfile.lock", "composer.json",
    "composer.lock", "go.mod", "go.sum", "vcpkg.json", "vcpkg-configuration.json", "conanfile.txt", "conan.lock",
    "requirements.txt", "requirements-dev.txt", "constraints.txt", "test_requirements.txt", "requirements/base.txt",
  ]) {
    assert.equal(isDocsOrConfigOnlyChange([path]), false, path);
  }
  // Pairing one with docs does not launder it either.
  assert.equal(isDocsOrConfigOnlyChange(["README.md", "package.json"]), false);
  // Only the direct children of a requirements/ directory are pip's split requirements.
  assert.equal(isDocsOrConfigOnlyChange(["requirements/notes/usage.txt"]), true);
});

test("a pipeline definition keeps the target-domain gate even though it is YAML", () => {
  // These say what runs and with which credentials, so they are the same change
  // class as a dependency manifest rather than settings text — and `Dockerfile`
  // was never relaxed, so relaxing the compose file that runs it would be
  // asymmetric.
  for (const path of [
    ".github/workflows/ci.yml",
    ".circleci/config.yml",
    ".gitlab-ci.yml",
    "docker-compose.yml",
    "deploy/docker-compose.prod.yaml",
    "azure-pipelines.yml",
  ]) {
    assert.equal(isDocsOrConfigOnlyChange([path]), false, path);
  }
  assert.equal(isDocsOrConfigOnlyChange(["README.md", ".github/workflows/ci.yml"]), false);
  // A plain settings file that merely lives near them is still relaxed.
  assert.equal(isDocsOrConfigOnlyChange([".github/dependabot.yml"]), true);
});

test("a settings-only change is docs/config-only but not docs-only", () => {
  const profile = classifyChange({
    changedPaths: ["excubitor.catalog.yaml"],
    unifiedDiff: "+++ b/excubitor.catalog.yaml\n+  - genius\n",
  });
  assert.equal(profile.docsOnly, false);
  assert.equal(profile.docsOrConfigOnly, true);
  assert.equal(profile.codeDomainRequired, false);
  assert.deepEqual(profile.kinds, ["config"]);
});

test("requires an application domain only when production code changed", () => {
  const catalogWithItsTest = classifyChange({
    changedPaths: ["excubitor.catalog.yaml", "test/catalog.test.mjs"],
  });
  assert.deepEqual(catalogWithItsTest.kinds, ["test", "config"]);
  assert.equal(catalogWithItsTest.codeDomainRequired, false);

  const productionCode = classifyChange({
    changedPaths: ["src/catalog.mjs", "test/catalog.test.mjs"],
  });
  assert.equal(productionCode.codeDomainRequired, true);
});

test("reports the runtime surfaces a registered unit test cannot stand in for", () => {
  const profile = classifyChange({
    changedPaths: ["src/server.mjs", "migrations/031_add_index.sql", "src/ui-layout.mjs"],
    unifiedDiff: "+++ b/src/server.mjs\n+one\n+two\n",
  });
  assert.deepEqual(profile.kinds, ["code", "infra"]);
  assert.equal(profile.codeDomainRequired, true);
  assert.equal(profile.docsOnly, false);
  assert.deepEqual([...profile.runtimeSurfaces].sort(), ["entrypoint", "migration", "ui"]);
  assert.equal(profile.changedFiles, 3);
  assert.equal(profile.added, 2);
});

test("a docs-only change carries no runtime surface even under a ui folder", () => {
  const profile = classifyChange({
    changedPaths: ["src/ui/guide.md"],
    unifiedDiff: "+++ b/src/ui/guide.md\n+text\n",
  });
  assert.equal(profile.docsOnly, true);
  assert.equal(profile.docsOrConfigOnly, true);
  assert.deepEqual(profile.runtimeSurfaces, []);
  assert.deepEqual(profile.kinds, ["docs"]);
});

test("records whether the change touched spec files", () => {
  assert.equal(classifyChange({ changedPaths: ["spec/feature/x.md"] }).touchesSpec, true);
  assert.equal(classifyChange({ changedPaths: ["src/x.mjs"] }).touchesSpec, false);
});

// 直下の `report/` は解析レポートの出力先で、生成物。 これが code へ落ちると
// 「生成物を追跡から外すだけの PR」がアプリケーションドメインを要求されて止まる
// (Concordia #1312 が実際にこれで action_required になった / Memoria #2022)。
test("直下の report/ は生成物として扱い、src/report/ の手書きコードは巻き込まない", () => {
  assert.equal(classifyPath("report/architecture-review.html"), "generated");
  assert.equal(classifyPath("report/stages/05-anatomia-analysis.html"), "generated");
  assert.equal(classifyPath("report/omnipotens-final.manifest.json"), "generated");

  // `report` は普通の語なので、深さを問わず当てると手書きのソースを巻き込む。
  // Concordia の src/report/generator.ts が実在するため、直下に固定してある。
  assert.equal(classifyPath("src/report/generator.ts"), "code");
  assert.equal(classifyPath("src/report/summary-event-excerpt.ts"), "code");
  assert.equal(classifyPath("web/src/pages/report/View.tsx"), "code");
});

test("生成レポートだけを消す変更はドメインも runtime verification も要求されない", () => {
  const changedPaths = [
    "report/architecture-review.html",
    "report/stages/00-source-manifest.html",
    "report/omnipotens-final.manifest.json",
  ];
  const classification = classifyChange({ changedPaths, unifiedDiff: "" });

  assert.deepEqual(classification.kinds, ["generated"]);
  // codeDomainRequired が立たないことが、target-domain ゲートを通す条件
  // (review-gate.mjs の needsTargetDomain)。
  assert.equal(classification.codeDomainRequired, false);
  assert.deepEqual(classification.runtimeSurfaces, []);
});

test("UI の .html は従来どおり code のままで runtime verification が緩まない", () => {
  // report/ を生成物にしたことで .html 全体の扱いを変えていないこと。
  assert.equal(classifyPath("web/public/index.html"), "code");
  assert.equal(classifyPath("public/index.html"), "code");
  assert.equal(classifyPath("src/ui/panel.html"), "code");

  const ui = classifyChange({ changedPaths: ["web/public/index.html"], unifiedDiff: "" });
  assert.equal(ui.codeDomainRequired, true);
  assert.ok(ui.runtimeSurfaces.includes("ui"), "ui 面として runtime verification の対象に残る");
});

test("C/C++ build scripts and dependency manifests are never planned as documentation", () => {
  // `CMakeLists.txt` ended in `.txt`, so a PR touching only it skipped the vulnerability
  // pass and the registered tests (with the Praesidium preflight) although it decides
  // what is compiled and which sources are downloaded and run at configure time.
  for (const path of ["CMakeLists.txt", "native/relay/CMakeLists.txt", "meson_options.txt"]) {
    const profile = classifyChange({ changedPaths: [path] });
    assert.deepEqual(profile.kinds, ["infra"], path);
    assert.equal(profile.docsOnly, false, path);
    assert.equal(profile.docsOrConfigOnly, false, path);
  }
  for (const path of ["conanfile.txt", "conan.lock", "vcpkg.json", "vcpkg-configuration.json"]) {
    const profile = classifyChange({ changedPaths: [path] });
    assert.equal(profile.docsOnly, false, path);
    assert.equal(profile.docsOrConfigOnly, false, path);
    assert.equal(profile.dependencyOnly, true, path);
  }
  // Paired with prose, a manifest still keeps an executable kind.
  assert.deepEqual(classifyChange({ changedPaths: ["conanfile.txt", "README.md"] }).kinds, ["docs", "config"]);
  // Presets pick the toolchain file and the compiler flags, like a CI pipeline.
  assert.equal(isDocsOrConfigOnlyChange(["CMakePresets.json"]), false);
  assert.equal(isDocsOrConfigOnlyChange(["CMakeUserPresets.json"]), false);
  // A Conan recipe is Python that Conan executes: code with full analysis, not a manifest.
  assert.deepEqual(classifyChange({ changedPaths: ["conanfile.py"] }).kinds, ["code"]);
  assert.equal(classifyChange({ changedPaths: ["conanfile.py"] }).dependencyOnly, false);
  // Plain text stays documentation.
  assert.equal(classifyChange({ changedPaths: ["notes.txt"] }).docsOnly, true);
  // pip's other manifest spellings: split requirements, prefixed names and constraints, at any
  // depth (Read the Docs installs docs/requirements.txt).
  for (const path of ["requirements/production.txt", "test-requirements.txt", "dev-requirements.txt", "constraints.txt",
    "docs/requirements.txt", "docs/constraints.txt"]) {
    const profile = classifyChange({ changedPaths: [path] });
    assert.deepEqual(profile.kinds, ["config"], path);
    assert.equal(profile.docsOnly, false, path);
    assert.equal(profile.docsOrConfigOnly, false, path);
    assert.equal(profile.dependencyOnly, true, path);
  }
  // Prose that merely mentions requirements or constraints stays documentation.
  for (const path of ["SYSTEM_REQUIREMENTS.txt", "docs/system-requirements.txt", "docs/design-constraints.txt"]) {
    assert.equal(classifyChange({ changedPaths: [path] }).docsOnly, true, path);
  }
});

test("native build trees under build/ keep their review, and vendored archives count as dependencies", () => {
  // zstd and lz4 keep their whole build system and single-file sources under build/.
  for (const path of ["build/cmake/CMakeLists.txt", "build/meson/meson.build", "build/VS2019/libzstd.vcxproj",
    "build/config/compiler/BUILD.gn", "cmake/opus.cmake", "Directory.Build.props"]) {
    assert.deepEqual(classifyChange({ changedPaths: [path] }).kinds, ["infra"], path);
  }
  assert.deepEqual(classifyChange({ changedPaths: ["build/single_file_libs/zstd.c"] }).kinds, ["code"]);
  // So are the solutions, old projects, CMake templates, make fragments (lz4's compile
  // recipe) and the scripts and resource files that tree runs or compiles.
  for (const path of ["build/VS2010/zstd.sln", "build/VS2008/zstd/zstd.vcproj", "build/cmake/zstdConfig.cmake.in",
    "build/make/multiconf.make", "build/single_file_libs/combine.sh", "build/meson/GetZstdLibraryVersion.py",
    "build/VS_scripts/build.generic.cmd", "build/visual/generate_vs2015.cmd", "build/VS2010/libzstd-dll/libzstd-dll.rc",
    "build/VS2022/build.bat", "build/windows/setup.ps1", "out/gen_version.py", "dist/package.sh"]) {
    assert.deepEqual(classifyChange({ changedPaths: [path] }).kinds, ["infra"], path);
  }
  for (const path of ["node_modules/x/CMakeLists.txt", "node_modules/x/build/a.sh", "dist/server.js", "build/index.js", "out/main.js"]) {
    assert.deepEqual(classifyChange({ changedPaths: [path] }).kinds, ["generated"], path);
  }
  for (const path of ["native/third_party/boost-1.87.0.zip", "3rdparty/zlib-1.3.1.tar.gz", "3rd_party/zlib.zip", "3rd-party/png.7z"]) {
    assert.deepEqual(classifyChange({ changedPaths: [path] }).kinds, ["config"], path);
  }
  assert.deepEqual(classifyChange({ changedPaths: ["assets/levels.zip"] }).kinds, ["asset"]);
});

test("native process entries and platform manifests are runtime surfaces, test runners are not", () => {
  for (const path of ["native/relay/main.cpp", "native/presenter/platform/macos/macos_main.mm",
    "native/program/platform/windows/windows_main.cpp", "src/WinMainEntry.cpp", "app/App.entitlements",
    "app/Info.plist", "app/Info.plist.in", "app/app.manifest"]) {
    assert.deepEqual(classifyChange({ changedPaths: [path] }).runtimeSurfaces, ["entrypoint"], path);
  }
  for (const path of ["native/tests/main.cpp", "native/relay/hub.cpp", "src/maintenance.cpp"]) {
    assert.deepEqual(classifyChange({ changedPaths: [path] }).runtimeSurfaces, [], path);
  }
  // A class named after the app or a server component is not a process entry, and
  // neither is a vendored or local test runner or an Xcode test bundle.
  for (const path of ["native/presenter/app/presenter_app.cpp", "native/program/app/program_app.cpp", "src/http_server.cc",
    "third_party/googletest/googletest/src/gtest_main.cc", "third_party/googletest/googlemock/src/gmock_main.cc",
    "third_party/benchmark/src/benchmark_main.cc", "tools/unit_test_main.cc", "__tests__/main.cpp", "unittests/main.cpp",
    "MyAppTests/Info.plist", "MyAppUITests/main.m"]) {
    assert.deepEqual(classifyChange({ changedPaths: [path] }).runtimeSurfaces, [], path);
  }
  for (const path of ["native/relay/server.cpp", "apps/contests/main.cpp", "tools/latest_main.cpp"]) {
    assert.deepEqual(classifyChange({ changedPaths: [path] }).runtimeSurfaces, ["entrypoint"], path);
  }
  assert.equal(classifyChange({ changedPaths: ["native/relay/hub.cpp"] }).nativeSources, true);
  assert.equal(classifyChange({ changedPaths: ["src/runner.mjs"] }).nativeSources, false);
});

test("path rules stay linear on long paths of repeated directories and names", () => {
  // A rule spanning a directory and an extension, or two `[^/]*` around a name, backtracked
  // quadratically: 256 KiB of `deps/x.zip/` took seconds.
  for (const unit of ["build/a.sh/", "deps/x.zip/", "3rd_party/", "WinMain", "test_main.", "requirements.txt/", "spec/", ".anatomia/"]) {
    // `x.jso` ends like a declaration file but is not one, so a spec rule reads to the end.
    const path = unit.repeat(Math.floor(256 * 1024 / unit.length)) + (unit.endsWith("/") ? "x.jso" : "y");
    const started = performance.now();
    classifyChange({ changedPaths: [path] });
    assert.ok(performance.now() - started < 500, unit);
  }
});
