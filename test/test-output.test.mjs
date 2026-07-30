import assert from "node:assert/strict";
import test from "node:test";
import { MAX_TEST_OUTPUT_BYTES, captureFailedTestOutput } from "../src/test-output.mjs";

test("keeps both streams of a failed case, labelled", () => {
  const output = captureFailedTestOutput({
    stdout: "1..2\nnot ok 2 - gate relaxes\n",
    stderr: "AssertionError: expected [] to deepEqual [ 'x' ]\n",
  });
  assert.equal(output.truncated, false);
  assert.match(output.text, /--- stdout ---\n1\.\.2\nnot ok 2 - gate relaxes/);
  assert.match(output.text, /--- stderr ---\nAssertionError/);
});

test("stores nothing when the failure printed nothing", () => {
  assert.equal(captureFailedTestOutput({ stdout: "", stderr: "   \n" }), null);
  assert.equal(captureFailedTestOutput({}), null);
});

test("replaces a secret-bearing line with its rule name, never the value", () => {
  // Both fixtures are assembled at runtime instead of written as literals: a
  // literal credential here is an added line like any other, so Revisor's own
  // leakage scan flags this file while reviewing it.
  const token = `ghp_${"a1B2c3D4e5F6g7H8i9J0".repeat(2)}`;
  const secret = ["S3cret", "value", "long", "enough", "x"].join("-");
  const output = captureFailedTestOutput({
    stdout: `using token ${token}\nnot ok 1 - auth\n`,
    stderr: `${["pass", "word"].join("")}: "${secret}"\n`,
  });
  assert.equal(output.text.includes(token), false);
  assert.equal(output.text.includes(secret), false);
  assert.match(output.text, /\[redacted: github-token\]/);
  assert.match(output.text, /\[redacted: embedded-credential\]/);
  // The surrounding, harmless lines survive: redaction is a mask, not a delete.
  assert.match(output.text, /not ok 1 - auth/);
});

test("keeps the tail within the cap and says so in the stored text", () => {
  const lines = [];
  for (let index = 0; index < 3_000; index += 1) lines.push(`line ${String(index).padStart(6, "0")}`);
  const output = captureFailedTestOutput({ stdout: `${lines.join("\n")}\n` });
  assert.equal(output.truncated, true);
  assert.match(output.text, /^\[truncated: kept the last 12288 of \d+ bytes\]\n/);
  assert.equal(output.text.includes("line 000000"), false);
  assert.match(output.text, /line 002999/);
  // The kept tail starts at a line boundary, not mid-line.
  assert.match(output.text.split("\n")[1], /^line \d{6}$/);
  assert.ok(Buffer.byteLength(output.text, "utf8") <= MAX_TEST_OUTPUT_BYTES + 128);
});

test("truncation never cuts a multi-byte character in half", () => {
  const output = captureFailedTestOutput({
    stdout: `${"日本語のログ行です\n".repeat(2_000)}`,
  });
  assert.equal(output.truncated, true);
  assert.equal(output.text.includes("\uFFFD"), false);
});
