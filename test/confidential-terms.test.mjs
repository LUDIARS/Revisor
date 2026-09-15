import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertCommitMessageFreeOfConfidentialTerms,
  confidentialTermsAdvisory,
  confidentialTermsPath,
  configuredConfidentialTermsAdvisory,
  configuredConfidentialTermsOutcome,
  isConfidentialTermsEnforced,
  loadConfidentialPolicy,
  loadConfidentialTerms,
  scanAddedDiffForConfidentialTerms,
  scanTextForConfidentialTerms,
} from "../src/confidential-terms.mjs";

const TERMS = [
  { id: "product-001", value: "secrettitle" },
  { id: "customer-001", value: "acmecorp" },
];

function diff(lines) {
  return lines.join("\n");
}

// 語を同梱すると、流出を止める仕組みが流出源になる。 未設定なら検査しない。
test("does nothing until an external term file is configured", () => {
  assert.equal(confidentialTermsPath({}), null);
  assert.equal(confidentialTermsPath({ REVISOR_CONFIDENTIAL_TERMS_FILE: "  " }), null);
  assert.equal(confidentialTermsPath({ REVISOR_CONFIDENTIAL_TERMS_FILE: "C:/terms.json" }), "C:/terms.json");
  assert.equal(loadConfidentialTerms(null), null);
  const result = scanAddedDiffForConfidentialTerms("+++ b/a.md\n@@ -0,0 +1 @@\n+SecretTitle\n", []);
  assert.deepEqual(result, {
    findings: [], totalFindings: 0, totalFiles: 0, truncated: false, scanned: false,
  });
});

test("reads terms from a file outside the repository", () => {
  const dir = mkdtempSync(join(tmpdir(), "terms-"));
  try {
    const path = join(dir, "terms.json");
    writeFileSync(path, JSON.stringify({ keywords: [{ id: "product-001", value: "SecretTitle" }, "AcmeCorp"] }));
    const terms = loadConfidentialTerms(path);
    assert.equal(terms.length, 2);
    // 値は小文字化して保持し、id は語そのものを含まないものだけ採る。
    assert.deepEqual(terms.map((term) => term.value).sort(), ["acmecorp", "secrettitle"]);
    assert.equal(terms.some((term) => term.id.toLowerCase().includes("secrettitle")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// id が語を含んでいたら採用しない。 id だけの報告からでも語が読めてしまう。
test("replaces an id that leaks the term it labels", () => {
  const dir = mkdtempSync(join(tmpdir(), "terms-"));
  try {
    const path = join(dir, "terms.json");
    writeFileSync(path, JSON.stringify({ keywords: [{ id: "SecretTitle-product", value: "SecretTitle" }] }));
    const terms = loadConfidentialTerms(path);
    assert.equal(terms[0].id.toLowerCase().includes("secrettitle"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("replaces ids that contain another confidential term or unsafe characters", () => {
  const dir = mkdtempSync(join(tmpdir(), "terms-"));
  try {
    const path = join(dir, "terms.json");
    writeFileSync(path, JSON.stringify({ keywords: [
      { id: "customer-acmecorp", value: "SecretTitle" },
      { id: "unsafe\nlabel", value: "AcmeCorp" },
    ] }));
    const terms = loadConfidentialTerms(path);
    assert.deepEqual(terms.map((term) => term.id).sort(), ["term:1", "term:2"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("does not expose a configured path or parser source fragment in load errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "terms-"));
  try {
    const path = join(dir, "SecretTitle-terms.json");
    writeFileSync(path, '{"keywords":["SecretTitle"],"broken":');
    assert.throws(
      () => loadConfidentialTerms(path),
      (error) => !error.message.includes(path) && !error.message.includes("SecretTitle"),
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rejects configured files that silently disable or leave the local filesystem", () => {
  const dir = mkdtempSync(join(tmpdir(), "terms-"));
  try {
    const path = join(dir, "terms.json");
    writeFileSync(path, JSON.stringify({ keywords: ["", { value: "  " }] }));
    assert.throws(() => loadConfidentialTerms(path), /at least one valid keyword/);
    assert.throws(() => loadConfidentialTerms("relative/terms.json"), /absolute local path/);
    assert.throws(() => loadConfidentialTerms("\\\\private-host\\terms.json"), /absolute local path/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("finds a term in an added line and reports only its id", () => {
  const result = scanAddedDiffForConfidentialTerms(diff([
    "+++ b/docs/plan.md",
    "@@ -0,0 +1,2 @@",
    "+SecretTitle の設計",
    "+関係のない行",
  ]), TERMS);
  assert.deepEqual(result.findings, [{ termId: "product-001", path: "docs/plan.md", line: 1 }]);
  assert.equal(JSON.stringify(result).toLowerCase().includes("secrettitle"), false);
});

// `server/<取引先名>-user-client.ts` のように、名前だけで判る形が実在する。
test("finds a term in the file path itself", () => {
  const result = scanAddedDiffForConfidentialTerms(diff([
    "+++ b/server/acmecorp-client.ts",
    "@@ -0,0 +1 @@",
    "+export const client = 1;",
  ]), TERMS);
  assert.deepEqual(result.findings, [{ termId: "customer-001", path: "[redacted-path:1]", line: 0 }]);
  assert.equal(result.totalFiles, 1);
  assert.equal(JSON.stringify(result).toLowerCase().includes("acmecorp"), false);
});

test("turns configuration failures into a generic advisory", () => {
  const dir = mkdtempSync(join(tmpdir(), "terms-"));
  try {
    const configuredPath = join(dir, "SecretTitle-missing-terms.json");
    const advisory = configuredConfidentialTermsAdvisory({
      unifiedDiff: "+++ b/a.md\n@@ -0,0 +1 @@\n+text\n",
      env: { REVISOR_CONFIDENTIAL_TERMS_FILE: configuredPath },
    });
    assert.match(advisory, /検査を実行できませんでした/);
    assert.equal(advisory.includes(configuredPath), false);
    assert.equal(advisory.includes("SecretTitle"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("checks raw changed paths when a binary diff has no file header", () => {
  const result = scanAddedDiffForConfidentialTerms(diff([
    "diff --git a/assets/logo.png b/assets/logo.png",
    "GIT binary patch",
  ]), TERMS, { changedPaths: ["assets/acmecorp-logo.png"] });
  assert.deepEqual(result.findings, [{
    termId: "customer-001", path: "[redacted-path:1]", line: 0,
  }]);
  assert.equal(JSON.stringify(result).toLowerCase().includes("acmecorp"), false);
});

test("does not confuse an added line beginning with two pluses for a file header", () => {
  const result = scanAddedDiffForConfidentialTerms(diff([
    "diff --git a/a.md b/a.md",
    "+++ b/a.md",
    "@@ -0,0 +1 @@",
    "+++ SecretTitle",
  ]), TERMS);
  assert.deepEqual(result.findings, [{ termId: "product-001", path: "a.md", line: 1 }]);
});

test("scans added content even when a Git-quoted path cannot be decoded", () => {
  const result = scanAddedDiffForConfidentialTerms(diff([
    "diff --git a/file b/file",
    '+++ "b/\\346\\234\\237.txt"',
    "@@ -0,0 +1 @@",
    "+SecretTitle",
  ]), TERMS);
  assert.deepEqual(result.findings, [{
    termId: "product-001", path: "[unparsed-diff-path]", line: 1,
  }]);
});

// 既存行はその PR が足した分ではない。 止める対象は追加差分だけ。
test("ignores removed and context lines", () => {
  const result = scanAddedDiffForConfidentialTerms(diff([
    "+++ b/a.md",
    "@@ -1,3 +1,2 @@",
    " SecretTitle は文脈行",
    "-SecretTitle を消す行",
    "+無関係な追加",
  ]), TERMS);
  assert.equal(result.totalFindings, 0);
});

test("matches case-insensitively so a lowercased mention is not missed", () => {
  const result = scanAddedDiffForConfidentialTerms(diff([
    "+++ b/a.md", "@@ -0,0 +1 @@", "+secrettitle mockup",
  ]), TERMS);
  assert.equal(result.totalFindings, 1);
});

test("summarises without naming the term or quoting the line", () => {
  const result = scanAddedDiffForConfidentialTerms(diff([
    "+++ b/a.md", "@@ -0,0 +1 @@", "+SecretTitle",
  ]), TERMS);
  const advisory = confidentialTermsAdvisory(result);
  assert.match(advisory, /公開できない語を含む追加差分: 1 箇所 \/ 1 ファイル/);
  assert.equal(advisory.toLowerCase().includes("secrettitle"), false);
  assert.equal(confidentialTermsAdvisory({ scanned: true, totalFindings: 0, findings: [] }), null);
  assert.equal(confidentialTermsAdvisory({ scanned: false, totalFindings: 0, findings: [] }), null);
});

// enforcement は語ファイル側に置く。 例外 (非公開リポジトリ) の名前を公開設定へ書かないため。
function policyFile(policy) {
  const dir = mkdtempSync(join(tmpdir(), "terms-policy-"));
  const path = join(dir, "terms.json");
  writeFileSync(path, JSON.stringify(policy));
  return { dir, path, env: { REVISOR_CONFIDENTIAL_TERMS_FILE: path } };
}

const ENFORCED = {
  keywords: [{ id: "product-001", value: "SecretTitle" }],
  enforcement: { mode: "enforce-except", exceptRepositories: ["Owner/PrivateRepo", "private-org/*"] },
};
const ADDED = diff(["+++ b/docs/a.md", "@@ -0,0 +1 @@", "+SecretTitle notes"]);

test("keeps advisory behaviour when the term file declares no enforcement", () => {
  const { dir, env } = policyFile({ keywords: [{ id: "product-001", value: "SecretTitle" }] });
  try {
    const outcome = configuredConfidentialTermsOutcome({ unifiedDiff: ADDED, repository: "Owner/Public", env });
    assert.equal(outcome.reason, null);
    assert.match(outcome.advisory, /1 箇所 \/ 1 ファイル/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("blocks a repository outside the exception list without naming the term", () => {
  const { dir, env } = policyFile(ENFORCED);
  try {
    const outcome = configuredConfidentialTermsOutcome({ unifiedDiff: ADDED, repository: "Owner/Public", env });
    assert.equal(outcome.advisory, null);
    assert.match(outcome.reason, /1 箇所 \/ 1 ファイル/);
    assert.equal(outcome.reason.toLowerCase().includes("secrettitle"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("keeps exact and owner wildcard exceptions advisory", () => {
  const { dir, path } = policyFile(ENFORCED);
  try {
    const policy = loadConfidentialPolicy(path);
    assert.equal(isConfidentialTermsEnforced(policy, "owner/privaterepo"), false);
    assert.equal(isConfidentialTermsEnforced(policy, "Private-Org/anything"), false);
    assert.equal(isConfidentialTermsEnforced(policy, "Owner/PrivateRepoFork"), true);
    assert.equal(isConfidentialTermsEnforced(policy, ""), true, "an unknown repository is enforced");
    assert.equal(isConfidentialTermsEnforced({ terms: [], enforcement: { mode: "advisory" } }, "a/b"), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("counts the pull request title and body as part of the published change", () => {
  const { dir, env } = policyFile(ENFORCED);
  try {
    const outcome = configuredConfidentialTermsOutcome({
      unifiedDiff: "",
      repository: "Owner/Public",
      pullRequest: { title: "Add secrettitle viewer", body: "line one\nSecretTitle again" },
      env,
    });
    assert.match(outcome.reason, /2 箇所 \/ 2 ファイル \(\[pr-title\], \[pr-body\]\)/);
    assert.deepEqual(
      scanTextForConfidentialTerms("a\nSecretTitle", [{ id: "product-001", value: "secrettitle" }], "[pr-body]"),
      [{ termId: "product-001", path: "[pr-body]", line: 2 }],
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("fails closed on a malformed enforcement declaration without disclosing the path", () => {
  const { dir, path, env } = policyFile({ ...ENFORCED, enforcement: { mode: "block-some" } });
  try {
    const outcome = configuredConfidentialTermsOutcome({ unifiedDiff: ADDED, repository: "Owner/Public", env });
    assert.equal(outcome.advisory, null);
    assert.match(outcome.reason, /実行できませんでした/);
    assert.equal(outcome.reason.includes(path), false);
    assert.throws(() => loadConfidentialPolicy(policyFile({
      ...ENFORCED, enforcement: { mode: "enforce-except", exceptRepositories: ["not a repo"] },
    }).path), /invalid repository pattern/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("refuses a squash commit message with a term only in enforced repositories", () => {
  const { dir, env } = policyFile(ENFORCED);
  try {
    assert.throws(
      () => assertCommitMessageFreeOfConfidentialTerms({ repository: "Owner/Public", title: "x", body: "SecretTitle", env }),
      (error) => /product-001/.test(error.message) && !/secrettitle/i.test(error.message),
    );
    assert.doesNotThrow(() => assertCommitMessageFreeOfConfidentialTerms({
      repository: "Owner/PrivateRepo", title: "SecretTitle", body: "", env,
    }));
    assert.doesNotThrow(() => assertCommitMessageFreeOfConfidentialTerms({
      repository: "Owner/Public", title: "clean", body: "clean", env,
    }));
    assert.doesNotThrow(() => assertCommitMessageFreeOfConfidentialTerms({
      repository: "Owner/Public", title: "SecretTitle", body: "", env: {},
    }), "no configured term file means no check");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
