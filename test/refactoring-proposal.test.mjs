import test from "node:test";
import assert from "node:assert/strict";
import { projectRefactoringProposals, refactoringProposal } from "../src/refactoring-proposal.mjs";

const repository = { repository: "LUDIARS/Example" };
function review(number, quality = {}) {
  return {
    repository: repository.repository, number, status: "merged", checkStatus: "test_ok",
    headSha: `head-${number}`, reviewedHeadSha: `head-${number}`,
    createdAt: `2026-09-${String(number).padStart(2, "0")}T00:00:00Z`,
    anatomia: { quality: {
      complexity: { functions: 12, score: 80, maximumCyclomatic: 4 },
      functionComplexity: {
        version: 1,
        metric: "call-out-degree-plus-one",
        functions: Array.from({ length: 12 }, (_, index) => ({
          key: `function-${index}`,
          structuralHash: null,
          value: 4,
        })),
      },
      changedOrphans: [], ...quality,
    }, architecture: { isolatedChangedAnchors: [] } },
  };
}

test("high absolute complexity suggests refactoring without requiring a baseline", () => {
  const lowScore = refactoringProposal(review(1, {
    complexity: { functions: 12, score: 50, maximumCyclomatic: 4 },
  }));
  assert.equal(lowScore.status, "suggested");
  assert.equal(lowScore.advisory, true);
  assert.equal(lowScore.findings.length, 1);

  const highFunction = review(1);
  highFunction.anatomia.quality.functionComplexity.functions[0].value = 20;
  const highFunctionProposal = refactoringProposal(highFunction);
  assert.equal(highFunctionProposal.status, "suggested");
  assert.equal(highFunctionProposal.findings.length, 1);

  const unrelatedCyclomatic = review(1, {
    complexity: { functions: 12, score: 80, maximumCyclomatic: 100 },
  });
  assert.equal(refactoringProposal(unrelatedCyclomatic).status, "clear");
  assert.equal(refactoringProposal(null).status, "unmeasured");
  assert.equal(refactoringProposal(review(1, {
    complexity: { functions: 0, score: 100 },
  })).status, "unmeasured");
  const incompleteSnapshot = review(1);
  incompleteSnapshot.anatomia.quality.functionComplexity.functions.pop();
  assert.equal(refactoringProposal(incompleteSnapshot).status, "unmeasured");
});

test("isolated anchors are deduplicated across the two reports", () => {
  const pr = review(1, { changedOrphans: ["a", "b", "c"].map((anchor) => ({ anchor })) });
  pr.anatomia.architecture.isolatedChangedAnchors = ["a", "b", "c", "d"];
  assert.equal(refactoringProposal(pr).status, "clear");
  pr.anatomia.architecture.isolatedChangedAnchors.push("e");
  assert.equal(refactoringProposal(pr).status, "suggested");
});

test("new healthy evidence clears the project marker; stale, closed and running reviews do not", () => {
  const old = review(1, { complexity: { functions: 10, score: 30 } });
  const healthy = review(2);
  const stale = { ...review(3), headSha: "unreviewed" };
  const closed = { ...review(4), status: "closed" };
  const running = { ...review(5), checkStatus: "running" };
  const unmeasured = { ...review(6), anatomia: { quality: {} } };
  const marker = (prs) => projectRefactoringProposals([repository], prs)[0].refactoringProposal;
  assert.equal(marker([stale, closed, running, unmeasured, old]).status, "suggested");
  assert.equal(marker([stale, healthy, closed, running, old]).status, "clear");
  assert.equal(marker([healthy, old]).sourcePrNumber, 2);
  assert.equal(marker([{ ...old, repository: "other/repo" }]).status, "unmeasured");
});
