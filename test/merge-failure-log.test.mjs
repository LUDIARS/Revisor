import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeFailureMessage,
  writeMergeFailureLog,
} from "../src/merge-failure-log.mjs";

test("writes one structured, redacted merge failure record", () => {
  let output = "";
  const token = `ghp_${"a".repeat(32)}`;
  const record = writeMergeFailureLog({
    error: new Error(`publish failed with ${token}`),
    repository: { repository: "LUDIARS/Product" },
    pullRequest: {
      id: "pr-1",
      number: 324,
      headRef: "feat/local",
      baseRef: "main",
    },
    mergeRootPath: "C:/state/merge-repositories/product",
    now: () => "2026-08-08T11:09:07.823Z",
    stream: { write(chunk) { output += chunk; } },
  });

  assert.equal(record.event, "local_pr_merge_failed");
  assert.equal(record.number, 324);
  assert.doesNotMatch(record.detail, /ghp_/);
  assert.equal(JSON.parse(output).timestamp, "2026-08-08T11:09:07.823Z");
  assert.doesNotMatch(mergeFailureMessage(new Error(token)), /ghp_/);
});
