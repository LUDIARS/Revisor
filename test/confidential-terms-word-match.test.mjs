import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  confidentialTermMatches,
  loadConfidentialTerms,
  scanAddedDiffForConfidentialTerms,
  scanTextForConfidentialTerms,
} from "../src/confidential-terms.mjs";

// 短い固有名を部分一致で登録すると一般語の一部に当たる。 語ごとに単語単位と大文字小文字の区別を選べる。
const WORD = { id: "product-002", value: "ZQX", match: "word", caseSensitive: true };
const WORD_ANY_CASE = { id: "product-003", value: "zqx", match: "word" };
const SUBSTRING = { id: "product-004", value: "zqx" };

function loadTerms(keywords) {
  const dir = mkdtempSync(join(tmpdir(), "terms-word-"));
  try {
    const path = join(dir, "terms.json");
    writeFileSync(path, JSON.stringify({ keywords }));
    return loadConfidentialTerms(path);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("loads the match mode and case sensitivity and keeps default terms unchanged", () => {
  const terms = loadTerms([
    { id: "product-002", value: "ZQX", match: "word", caseSensitive: true },
    { id: "product-004", value: "Zqx-Long" },
  ]);
  assert.deepEqual(terms, [
    { id: "product-004", value: "zqx-long" },
    { id: "product-002", value: "ZQX", match: "word", caseSensitive: true },
  ]);
});

test("rejects an unknown match mode or a non-boolean caseSensitive", () => {
  assert.throws(() => loadTerms([{ value: "ZQX", match: "prefix" }]));
  assert.throws(() => loadTerms([{ value: "ZQX", caseSensitive: "yes" }]));
});

test("matches a word term only between non-alphanumeric boundaries", () => {
  assert.equal(confidentialTermMatches("ZQX の設計", WORD), true);
  assert.equal(confidentialTermMatches("Assets/ZQX/Scripts/a.cs", WORD), true);
  assert.equal(confidentialTermMatches("ZQX_HUD", WORD), true);
  assert.equal(confidentialTermMatches("ZQXUnityProjects", WORD), false);
  assert.equal(confidentialTermMatches("abcZQX", WORD), false);
  assert.equal(confidentialTermMatches("zqx", WORD), false);
});

test("ignores case for a word term unless caseSensitive is set", () => {
  assert.equal(confidentialTermMatches("the zqx-tool", WORD_ANY_CASE), true);
  assert.equal(confidentialTermMatches("Zqx", WORD_ANY_CASE), true);
  assert.equal(confidentialTermMatches("azqx", WORD_ANY_CASE), false);
});

test("keeps substring matching as the default", () => {
  assert.equal(confidentialTermMatches("ZQXservice", SUBSTRING), true);
});

test("loads the existing token dictionary mode without changing word semantics", () => {
  const [term] = loadTerms([{ id: "product-token", value: "ZQX", match: "token" }]);
  assert.deepEqual(term, { id: "product-token", value: "zqx", match: "token" });
  assert.equal(confidentialTermMatches("fix ZQX", term), true);
  assert.equal(confidentialTermMatches("Assets/ZQX/a.cs", term), true);
  assert.equal(confidentialTermMatches("prefixZQX", term), false);
  assert.equal(confidentialTermMatches("ZQX1", term), false);
  assert.equal(confidentialTermMatches("ZQX_HUD", term), false);
  assert.equal(confidentialTermMatches("_ZQX", term), false);
  assert.equal(confidentialTermMatches("前ZQX後", term), false);
  assert.equal(confidentialTermMatches("ZQX_HUD", WORD), true);
});

test("token mode preserves explicit case sensitivity on message and diff surfaces", () => {
  const terms = loadTerms([{ id: "product-token", value: "ZQX", match: "token", caseSensitive: true }]);
  assert.deepEqual(scanTextForConfidentialTerms("zqx\nZQX_HUD\nfix ZQX", terms, "[message]"), [
    { termId: "product-token", path: "[message]", line: 3 },
  ]);
  const result = scanAddedDiffForConfidentialTerms("+++ b/plan.md\n@@ -0,0 +1,3 @@\n+zqx\n+ZQX_HUD\n+fix ZQX\n", terms);
  assert.deepEqual(result.findings, [{ termId: "product-token", path: "plan.md", line: 3 }]);
});

test("applies the word rule to added lines, paths and the pull request text", () => {
  const result = scanAddedDiffForConfidentialTerms([
    "+++ b/docs/ZQX/plan.md",
    "@@ -0,0 +1,3 @@",
    "+ZQX の設計",
    "+zqx は小文字",
    "+ZQXA は別の語",
  ].join("\n"), [WORD]);
  assert.deepEqual(result.findings, [
    { termId: "product-002", path: "[redacted-path:1]", line: 0 },
    { termId: "product-002", path: "[redacted-path:1]", line: 1 },
  ]);
  assert.deepEqual(
    scanTextForConfidentialTerms("ZQXA\nfix ZQX", [WORD], "[pr-body]"),
    [{ termId: "product-002", path: "[pr-body]", line: 2 }],
  );
});
