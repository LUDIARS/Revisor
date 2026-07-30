import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyChange,
  classifyPath,
  diffLineStats,
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
  assert.equal(classifyPath("assets/logo.png"), "asset");
  assert.equal(classifyPath("src/runner.mjs"), "code");
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
  assert.equal(isDocsOrConfigOnlyChange(["app.yaml", "src/runner.mjs"]), false);
  assert.equal(isDocsOrConfigOnlyChange(["scripts/deploy.ps1"]), false);
  assert.equal(isDocsOrConfigOnlyChange([]), false);
});

test("a dependency manifest keeps the target-domain gate even though it looks like config", () => {
  // Editing these pulls third-party code into the build, so the relaxation must
  // not cover them (neco 2026-07-30).
  for (const path of [
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "Cargo.toml",
    "requirements-dev.txt",
    "composer.json",
    "go.mod",
  ]) {
    assert.equal(isDocsOrConfigOnlyChange([path]), false, path);
  }
  // Pairing one with docs does not launder it either.
  assert.equal(isDocsOrConfigOnlyChange(["README.md", "package.json"]), false);
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
  assert.deepEqual(profile.kinds, ["config"]);
});

test("reports the runtime surfaces a registered unit test cannot stand in for", () => {
  const profile = classifyChange({
    changedPaths: ["src/server.mjs", "migrations/031_add_index.sql", "src/ui-layout.mjs"],
    unifiedDiff: "+++ b/src/server.mjs\n+one\n+two\n",
  });
  assert.deepEqual(profile.kinds, ["code", "infra"]);
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
