// Keeps the output of a failed registered test case so the PR detail page can say
// *why* it failed. Only failures are captured: a passing case has nothing to
// diagnose and storing its log would grow the state file for every review.
//
// The stored text is not raw process output. It goes through the same boundary the
// leakage findings obey — a line that matches a secret rule is replaced by the rule
// name, never by the matched value — because a test can print an environment
// variable, a token, or a request header on its way to failing.

import { redactSecretLines } from "./leakage.mjs";

// 12 KB per failed case. A Node test-runner failure block (assertion diff plus the
// stack that produced it) is a few kilobytes, so this holds the part a human reads
// while keeping a whole suite of failures far below the size at which a PR record
// stops being a record. The tail is kept rather than the head because runners print
// the failure summary last.
export const MAX_TEST_OUTPUT_BYTES = 12 * 1024;

function truncationNotice(originalBytes) {
  return `[truncated: kept the last ${MAX_TEST_OUTPUT_BYTES} of ${originalBytes} bytes]`;
}

function joinStreams(stdout, stderr) {
  const sections = [];
  if (stdout.trim() !== "") sections.push(`--- stdout ---\n${stdout.trimEnd()}`);
  if (stderr.trim() !== "") sections.push(`--- stderr ---\n${stderr.trimEnd()}`);
  return sections.join("\n\n");
}

// Cuts on a byte boundary and then drops whatever remains of the first line, so the
// kept tail never starts inside a multi-byte character or mid-line. Truncation is
// always stated in the text itself: a silently shortened log reads like a complete
// one and sends the reader looking for a cause that was cut off.
function keepTail(text) {
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= MAX_TEST_OUTPUT_BYTES) return { text, truncated: false };
  const tail = Buffer.from(text, "utf8")
    .subarray(originalBytes - MAX_TEST_OUTPUT_BYTES)
    .toString("utf8");
  const firstBreak = tail.indexOf("\n");
  const fromLineStart = (firstBreak === -1 ? tail : tail.slice(firstBreak + 1))
    .replace(/^\uFFFD+/, "");
  return {
    text: `${truncationNotice(originalBytes)}\n${fromLineStart}`,
    truncated: true,
  };
}

// Returns null when there is nothing worth storing, so the outcome record keeps no
// empty `output` key and an old record without one stays indistinguishable from a
// failure that printed nothing.
export function captureFailedTestOutput({ stdout = "", stderr = "" } = {}) {
  const joined = joinStreams(String(stdout ?? ""), String(stderr ?? ""));
  if (joined === "") return null;
  return keepTail(redactSecretLines(joined));
}
