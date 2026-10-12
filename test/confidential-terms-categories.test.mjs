import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertCommitMessageFreeOfConfidentialTerms,
  configuredConfidentialTermsOutcome,
  isConfidentialKindEnforced,
  loadConfidentialPolicy,
  scanAddedDiffForConfidentialTerms,
} from "../src/confidential-terms.mjs";
import { enabledBuiltinDetectors } from "../src/host-identifiers.mjs";

// 架空の値を組み立てて使う (このリポジトリ自身の差分で検査が反応しないように)。
const fakeIp = ["10", "20", "30", "40"].join(".");
const fakePath = ["Q:", "Fictional", "Place"].join("/");
const fakeMachine = ["zz", "host", "77"].join("-");
const fakeSite = ["zz", "site", "north"].join("-");

function policyFile(policy) {
  const dir = mkdtempSync(join(tmpdir(), "terms-category-"));
  const path = join(dir, "terms.json");
  writeFileSync(path, JSON.stringify(policy));
  return { dir, path, env: { REVISOR_CONFIDENTIAL_TERMS_FILE: path } };
}

const BASE = {
  keywords: [
    { id: "product-001", value: "SecretTitle" },
    { id: "machine-001", value: fakeMachine, category: "machine-name" },
    { id: "site-001", value: fakeSite, category: "site-name" },
  ],
  enforcement: { mode: "enforce-except", exceptRepositories: ["owner/private"] },
};

const diff = (...lines) => ["+++ b/docs/runbook.md", `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join("\n");

test("reports built-in detector findings by kind without the matched value", () => {
  const result = scanAddedDiffForConfidentialTerms(
    diff(`ssh to ${fakeIp}`, `cd ${fakePath}`, "plain"),
    [],
    { detectors: enabledBuiltinDetectors({}) },
  );
  assert.deepEqual(result.findings, [
    { termId: "private-ip", path: "docs/runbook.md", line: 1, kind: "private-ip" },
    { termId: "local-path", path: "docs/runbook.md", line: 2, kind: "local-path" },
  ]);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(fakeIp), false);
  assert.equal(serialized.includes("Fictional"), false);
});

test("new kinds stay advisory by default while legacy terms keep their enforcement", () => {
  const { dir, env } = policyFile(BASE);
  try {
    const outcome = configuredConfidentialTermsOutcome({
      unifiedDiff: diff(`host ${fakeMachine} at ${fakeIp}`, `site ${fakeSite}`, "SecretTitle"),
      repository: "owner/public",
      env,
    });
    assert.match(outcome.reason, /1 箇所 \/ 1 ファイル/);
    assert.doesNotMatch(outcome.reason, /種類/, "legacy-only summary keeps the old wording");
    assert.match(outcome.advisory, /3 箇所 \/ 1 ファイル/);
    assert.match(outcome.advisory, /\[種類: machine-name 1, private-ip 1, site-name 1\]/);
    for (const value of [fakeIp, fakeMachine, fakeSite]) {
      assert.equal(outcome.advisory.includes(value), false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a kind set to enforce blocks outside the exception list and off disables it", () => {
  const { dir, path, env } = policyFile({
    ...BASE,
    categories: { "private-ip": "enforce", "local-path": "off" },
  });
  try {
    const policy = loadConfidentialPolicy(path);
    assert.equal(isConfidentialKindEnforced(policy, "owner/public", "private-ip"), true);
    assert.equal(isConfidentialKindEnforced(policy, "owner/private", "private-ip"), false);
    assert.equal(isConfidentialKindEnforced(policy, "owner/public", "site-name"), false);
    assert.equal(isConfidentialKindEnforced(policy, "owner/public", null), true);

    const outcome = configuredConfidentialTermsOutcome({
      unifiedDiff: diff(`ip ${fakeIp}`, `path ${fakePath}`),
      repository: "owner/public",
      env,
    });
    assert.match(outcome.reason, /1 箇所 \/ 1 ファイル.*\[種類: private-ip 1\]/);
    assert.equal(outcome.advisory, null, "local-path is off");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pull request text and the squash message follow the per-kind mode", () => {
  const { dir, env } = policyFile({ ...BASE, categories: { "site-name": "enforce" } });
  try {
    const outcome = configuredConfidentialTermsOutcome({
      unifiedDiff: "",
      repository: "owner/public",
      pullRequest: { title: `deploy to ${fakeSite}`, body: `from ${fakeIp}` },
      env,
    });
    assert.match(outcome.reason, /\[pr-title\]/);
    assert.match(outcome.advisory, /\[pr-body\]/);
    assert.throws(
      () => assertCommitMessageFreeOfConfidentialTerms({ repository: "owner/public", title: fakeSite, body: "", env }),
      (error) => /site-001/.test(error.message) && !error.message.includes(fakeSite),
    );
    assert.doesNotThrow(() => assertCommitMessageFreeOfConfidentialTerms({
      repository: "owner/public", title: "ok", body: `advisory only ${fakeIp}`, env,
    }));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rejects an unknown keyword category or category mode instead of silently skipping", () => {
  const unknownCategory = policyFile({ keywords: [{ id: "x-1", value: "abc", category: "hostname" }] });
  const unknownMode = policyFile({ keywords: ["abc"], categories: { "private-ip": "warn" } });
  try {
    assert.throws(() => loadConfidentialPolicy(unknownCategory.path), /unknown category/);
    const outcome = configuredConfidentialTermsOutcome({ unifiedDiff: diff("x"), env: unknownMode.env });
    assert.match(outcome.reason, /実行できませんでした/);
  } finally {
    rmSync(unknownCategory.dir, { recursive: true, force: true });
    rmSync(unknownMode.dir, { recursive: true, force: true });
  }
});
