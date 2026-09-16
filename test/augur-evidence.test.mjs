import assert from "node:assert/strict";
import test from "node:test";
import { experienceEvidenceFor } from "../src/augur-evidence.mjs";

test("counts only evidence from the requested head and Augur run", () => {
  const files = new Map([
    ["repo/.augur/runs/one.json", JSON.stringify({ runId: "run-1", headSha: "head-1", evidence: [{ id: "a" }, { id: "b" }] })],
    ["repo/.augur/runs/two.json", JSON.stringify({ runId: "run-2", headSha: "head-2", evidence: [{ id: "c" }] })],
  ]);
  const result = experienceEvidenceFor({ worktreePath: "repo", headSha: "head-1", runIds: ["run-1"] }, {
    exists: (path) => path.replaceAll("\\", "/") === "repo/.augur/runs",
    list: () => ["one.json", "two.json"],
    read: (path) => files.get(path.replaceAll("\\", "/")),
  });
  assert.deepEqual(result, { status: "recorded", count: 2 });
});

test("does not treat absent evidence as a successful experience check", () => {
  const result = experienceEvidenceFor({ worktreePath: "repo", headSha: "head-1" }, {
    exists: () => false,
  });
  assert.deepEqual(result, { status: "unverified", count: 0 });
});
