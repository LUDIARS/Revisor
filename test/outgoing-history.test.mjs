import assert from "node:assert/strict";
import test from "node:test";
import { scanCommitMessageLog } from "../src/outgoing-history.mjs";

test("commit messages preserve body line locations and never return values", () => {
  const sha = "a".repeat(40);
  const secret = "gh" + "p_" + "abcdefghijklmnopqrstuvwxyz123456";
  const findings = scanCommitMessageLog(`${sha}\nsafe subject\n\n${secret}\n\0`);
  assert.deepEqual(findings, [{ rule: "github-token", path: `commit/${sha}/message`, line: 3 }]);
  assert.ok(!JSON.stringify(findings).includes(secret));
});

test("invalid message records fail closed without including their contents", () => {
  const secret = "gh" + "p_" + "abcdefghijklmnopqrstuvwxyz123456";
  assert.throws(() => scanCommitMessageLog(secret + "\nbody\0"), error => !error.message.includes(secret));
  assert.deepEqual(scanCommitMessageLog(""), []);
});

test("commit messages enforce confidential terms while respecting repository exceptions", () => {
  const sha = "b".repeat(40);
  const value = "confidential-" + "fixture-name";
  const confidentialPolicy = {
    terms: [{ id: "term:fixture", value }],
    enforcement: { mode: "enforce-except", exceptRepositories: ["ludiars/private-fixture"] },
    categories: {}, workspaceRoots: [],
  };
  const log = `${sha}\nsafe subject\n\n${value}\n\0`;
  const findings = scanCommitMessageLog(log, { confidentialPolicy, repository: "LUDIARS/Product" });
  assert.deepEqual(findings, [{ rule: "confidential-term", termId: "term:fixture", path: `commit/${sha}/message`, line: 3 }]);
  assert.ok(!JSON.stringify(findings).includes(value));
  assert.deepEqual(scanCommitMessageLog(log, { confidentialPolicy, repository: "LUDIARS/private-fixture" }), []);
});

test("commit messages respect enforced, advisory and off host categories", () => {
  const sha = "c".repeat(40);
  const log = `${sha}\nsafe subject\n\n${"10." + "20.30.40"}\n\0`;
  for (const mode of ["advisory", "off", "enforce"]) {
    const confidentialPolicy = {
      terms: [], enforcement: { mode: "advisory", exceptRepositories: [] },
      categories: { "private-ip": mode }, workspaceRoots: [],
    };
    const findings = scanCommitMessageLog(log, { confidentialPolicy, repository: "LUDIARS/Product" });
    assert.equal(findings.length, mode === "enforce" ? 1 : 0);
    if (mode === "enforce") assert.equal(findings[0].kind, "private-ip");
  }
});
