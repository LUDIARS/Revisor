import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertCommitMessageFreeOfConfidentialTerms,
  configuredConfidentialTermsOutcome,
  loadConfidentialPolicy,
  scanAddedDiffForConfidentialTerms,
} from "../src/confidential-terms.mjs";
import {
  enabledBuiltinDetectors,
  localPathsAllUnderRoots,
  normalizeWorkspaceRoots,
} from "../src/host-identifiers.mjs";
import {
  isExcludedHostFinding,
  isGeneratedReportPath,
  isTestPath,
} from "../src/leak-exclusions.mjs";

// 値はすべて架空で、 しかも組み立てて作る。 ソースに直書きすると、 この検査自体が
// このリポジトリの差分に反応する。
const BS = String.fromCharCode(92);
const fakeRoot = ["Q:", "Fictional", "Space"].join("/");
const rootedSlash = [fakeRoot, "SomeRepo", "src"].join("/");
const rootedBackslash = ["Q:", "Fictional", "Space", "SomeRepo"].join(BS);
const outsidePath = ["Q:", "Elsewhere", "notes"].join("/");
const outsideHome = ["", "Users", "zz-person", "notes"].join("/");
const fakeIp = ["10", "20", "30", "40"].join(".");
const fakeMachine = ["zz", "host", "77"].join("-");

test("generated report and test paths follow the audit's path rules", () => {
  for (const path of ["report/index.md", "pkg/report/summary.json", "docs/view.html", "out/page.htm", "x/data.html.json"]) {
    assert.equal(isGeneratedReportPath(path), true, path);
  }
  for (const path of ["reports/a.md", "src/reporter.mjs", "docs/html-notes.md"]) {
    assert.equal(isGeneratedReportPath(path), false, path);
  }
  for (const path of ["test/a.mjs", "pkg/tests/a.ts", "src/__tests__/a.js", "fixtures/a.json", "x/fixture/b.txt", "src/a.test.ts", "src/a.spec.js", `src${BS}tests${BS}a.mjs`]) {
    assert.equal(isTestPath(path), true, path);
  }
  for (const path of ["src/testing.mjs", "contest/a.md", "src/attest.mjs", "docs/spec/a.md"]) {
    assert.equal(isTestPath(path), false, path);
  }
});

test("workspace roots are normalized and broad or malformed roots fail closed", () => {
  assert.deepEqual(normalizeWorkspaceRoots(undefined), []);
  assert.deepEqual(normalizeWorkspaceRoots([`${fakeRoot}/`, rootedBackslash]), [
    fakeRoot.toLowerCase(),
    [fakeRoot, "SomeRepo"].join("/").toLowerCase(),
  ]);
  assert.throws(() => normalizeWorkspaceRoots("Q:/x"), /must be an array/);
  for (const bad of [["Q:/"], ["/"], ["/Users"], ["relative/path"], [42]]) {
    assert.throws(() => normalizeWorkspaceRoots(bad), /invalid root/, JSON.stringify(bad));
  }
});

test("a line is excluded only when every concrete local path sits under a root", () => {
  const roots = normalizeWorkspaceRoots([fakeRoot]);
  assert.equal(localPathsAllUnderRoots(`cd ${rootedSlash}`, roots), true);
  assert.equal(localPathsAllUnderRoots(`cd ${rootedBackslash.toLowerCase()} && ls`, roots), true);
  assert.equal(localPathsAllUnderRoots(`${rootedSlash} and ${outsidePath}`, roots), false);
  assert.equal(localPathsAllUnderRoots(`${rootedSlash} and ${outsideHome}/x`, roots), false);
  assert.equal(localPathsAllUnderRoots(`${fakeRoot}Other/x`, roots), false, "prefix of a sibling folder");
  assert.equal(localPathsAllUnderRoots("no paths here", roots), false);
  assert.equal(localPathsAllUnderRoots(`cd ${rootedSlash}`, []), false, "no roots configured");
});

test("only host-category findings are excluded and the root rule is local-path only", () => {
  const options = { workspaceRoots: normalizeWorkspaceRoots([fakeRoot]) };
  assert.equal(isExcludedHostFinding({ kind: "private-ip", path: "test/a.mjs" }, options), true);
  assert.equal(isExcludedHostFinding({ kind: "machine-name", path: "report/a.md" }, options), true);
  assert.equal(isExcludedHostFinding({ kind: null, path: "test/a.mjs" }, options), false, "legacy keyword");
  assert.equal(isExcludedHostFinding({ path: "report/a.html" }, options), false, "legacy keyword");
  assert.equal(isExcludedHostFinding({ kind: "local-path", path: "docs/a.md", lineText: `cd ${rootedSlash}` }, options), true);
  assert.equal(isExcludedHostFinding({ kind: "private-ip", path: "docs/a.md", lineText: `cd ${rootedSlash} ${fakeIp}` }, options), false);
  assert.equal(isExcludedHostFinding({ kind: "local-path", path: "docs/a.md", lineText: `cd ${outsidePath}` }, options), false);
});

const diffFor = (path, ...lines) => [`diff --git a/${path} b/${path}`, `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join("\n");

test("the diff scan drops excluded host findings and counts them separately", () => {
  const terms = [
    { id: "product-001", value: "secrettitle" },
    { id: "machine-001", value: fakeMachine, category: "machine-name" },
  ];
  const unifiedDiff = [
    diffFor("test/a.test.mjs", `host ${fakeMachine} ${fakeIp}`, "SecretTitle"),
    diffFor("docs/runbook.md", `cd ${rootedSlash}`, `cd ${outsidePath}`, `ip ${fakeIp}`),
  ].join("\n");
  const result = scanAddedDiffForConfidentialTerms(unifiedDiff, terms, {
    detectors: enabledBuiltinDetectors({}),
    exclusions: { workspaceRoots: normalizeWorkspaceRoots([fakeRoot]) },
  });
  assert.deepEqual(result.findings, [
    { termId: "product-001", path: "test/a.test.mjs", line: 2 },
    { termId: "local-path", path: "docs/runbook.md", line: 2, kind: "local-path" },
    { termId: "private-ip", path: "docs/runbook.md", line: 3, kind: "private-ip" },
  ]);
  assert.equal(result.excludedFindings, 3);
  assert.equal(JSON.stringify(result).includes("Fictional"), false);
});

function policyFile(policy) {
  const dir = mkdtempSync(join(tmpdir(), "terms-exclusion-"));
  const path = join(dir, "terms.json");
  writeFileSync(path, JSON.stringify(policy));
  return { dir, env: { REVISOR_CONFIDENTIAL_TERMS_FILE: path } };
}

const POLICY = {
  keywords: [{ id: "machine-001", value: fakeMachine, category: "machine-name" }],
  categories: { "private-ip": "enforce", "machine-name": "enforce" },
  workspaceRoots: [fakeRoot],
};

test("enforced kinds in tests and reports no longer block the review", () => {
  const { dir, env } = policyFile(POLICY);
  try {
    assert.deepEqual(loadConfidentialPolicy(env.REVISOR_CONFIDENTIAL_TERMS_FILE).workspaceRoots, [fakeRoot.toLowerCase()]);
    const excludedOnly = configuredConfidentialTermsOutcome({
      unifiedDiff: [
        diffFor("test/hosts.test.mjs", `${fakeMachine} ${fakeIp}`),
        diffFor("report/run.html", `${fakeIp}`),
      ].join("\n"),
      repository: "owner/public",
      env,
    });
    assert.deepEqual(excludedOnly, { advisory: null, reason: null });
    const blocked = configuredConfidentialTermsOutcome({
      unifiedDiff: diffFor("docs/runbook.md", `${fakeMachine} ${fakeIp}`),
      repository: "owner/public",
      env,
    });
    assert.match(blocked.reason, /\[種類: machine-name 1, private-ip 1\]/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pull request text and squash messages apply only the workspace-root rule", () => {
  const { dir, env } = policyFile({ ...POLICY, categories: { ...POLICY.categories, "local-path": "enforce" } });
  try {
    const rooted = configuredConfidentialTermsOutcome({
      unifiedDiff: "",
      pullRequest: { title: "t", body: `see ${rootedSlash}` },
      repository: "owner/public",
      env,
    });
    assert.equal(rooted.reason, null);
    assert.doesNotThrow(() => assertCommitMessageFreeOfConfidentialTerms({
      repository: "owner/public", title: "t", body: `see ${rootedSlash}`, env,
    }));
    assert.throws(() => assertCommitMessageFreeOfConfidentialTerms({
      repository: "owner/public", title: "t", body: `see ${outsidePath}`, env,
    }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a malformed workspaceRoots declaration fails the policy load", () => {
  const { dir, env } = policyFile({ ...POLICY, workspaceRoots: ["Q:/"] });
  try {
    assert.throws(() => loadConfidentialPolicy(env.REVISOR_CONFIDENTIAL_TERMS_FILE), /invalid root/);
    const outcome = configuredConfidentialTermsOutcome({ unifiedDiff: "", repository: "owner/public", env });
    assert.match(outcome.reason, /実行できませんでした/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
