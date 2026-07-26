import assert from "node:assert/strict";
import test from "node:test";
import { scanAddedDiffForLeaks } from "../src/leakage.mjs";

function diff(path, lines) {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -0,0 +1,3 @@",
    ...lines.map((line) => `+${line}`),
  ].join("\n");
}

test("finds known tokens without returning their values", () => {
  const secret = "ghp_" + "A".repeat(36);
  const result = scanAddedDiffForLeaks(diff("src/config.mjs", [
    `const token = "${secret}";`,
  ]));
  assert.deepEqual(result.findings, [{
    rule: "github-token",
    path: "src/config.mjs",
    line: 1,
  }]);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test("flags private material, webhooks, embedded credentials, and sensitive files", () => {
  const privateKey = "-----BEGIN " + "PRIVATE KEY-----";
  const webhook = "https://discord.com/api/webhooks/123456789/" + "x".repeat(32);
  const result = scanAddedDiffForLeaks(diff(".env.production", [
    privateKey,
    webhook,
    'client_secret = "HighlySuspiciousCredential123!"',
  ]));
  assert.deepEqual(
    result.findings.map((finding) => finding.rule),
    ["sensitive-file", "private-key", "discord-webhook", "embedded-credential"],
  );
  assert.equal(result.scannedAddedLines, 3);
});

test("allows explicit templates and placeholders", () => {
  const result = scanAddedDiffForLeaks(diff(".env.example", [
    'API_KEY="<your_api_key>"',
    'token = "${TOKEN_FROM_ENV}"',
    'password = "example-placeholder-value"',
  ]));
  assert.deepEqual(result.findings, []);
});

test("tracks added line numbers across deletion and context lines", () => {
  const secret = "AKIA" + "A".repeat(16);
  const result = scanAddedDiffForLeaks([
    "diff --git a/app.js b/app.js",
    "--- a/app.js",
    "+++ b/app.js",
    "@@ -10,2 +10,3 @@",
    " context",
    "-removed",
    `+const key = "${secret}";`,
    "+next",
  ].join("\n"));
  assert.equal(result.findings[0].line, 11);
});

test("redacts a credential-shaped file path", () => {
  const secret = "ghp_" + "B".repeat(36);
  const result = scanAddedDiffForLeaks(diff(`fixtures/${secret}.txt`, [
    `const token = "${secret}";`,
  ]));
  assert.equal(result.findings[0].path, "[redacted-path]");
  assert.equal(JSON.stringify(result).includes(secret), false);
});
