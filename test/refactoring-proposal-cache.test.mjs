import assert from "node:assert/strict";
import test from "node:test";
import { RefactoringProposalCache } from "../src/refactoring-proposal-cache.mjs";

const repositories = [{ repository: "LUDIARS/Example" }];

function analysis(score) {
  return {
    quality: {
      complexity: { functions: 1, score },
      functionComplexity: {
        version: 1,
        metric: "call-out-degree-plus-one",
        functions: [{ key: "f", structuralHash: null, value: 1 }],
      },
      projectOrphans: { status: "measured", scope: "project", count: 0 },
    },
  };
}

function listed(updatedAt) {
  return {
    id: "pr-1", repository: "LUDIARS/Example", number: 1, status: "merged",
    checkStatus: "test_ok", headSha: "h", reviewedHeadSha: "h",
    createdAt: "2026-09-01T00:00:00Z", updatedAt,
  };
}

test("loads a PR's analysis once until its record changes", () => {
  const loads = [];
  let score = 80;
  const cache = new RefactoringProposalCache((id) => {
    loads.push(id);
    return analysis(score);
  });

  assert.equal(cache.project(repositories, [listed("t1")])[0].refactoringProposal.status, "clear");
  assert.equal(cache.project(repositories, [listed("t1")])[0].refactoringProposal.status, "clear");
  assert.deepEqual(loads, ["pr-1"]);

  score = 30;
  assert.equal(cache.project(repositories, [listed("t2")])[0].refactoringProposal.status, "suggested");
  assert.deepEqual(loads, ["pr-1", "pr-1"]);
});

test("uses an analysis already on the record without loading", () => {
  const cache = new RefactoringProposalCache(() => {
    throw new Error("must not load");
  });
  const projected = cache.project(repositories, [{ ...listed("t1"), anatomia: analysis(80) }]);
  assert.equal(projected[0].refactoringProposal.status, "clear");
});

test("a repository without a completed review stays unmeasured without loading", () => {
  const cache = new RefactoringProposalCache(() => {
    throw new Error("must not load");
  });
  const running = { ...listed("t1"), checkStatus: "running" };
  assert.equal(cache.project(repositories, [running])[0].refactoringProposal.status, "unmeasured");
});
