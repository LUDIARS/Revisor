import assert from "node:assert/strict";
import test from "node:test";
import { domainInstruction } from "../src/reviewer-prompt.mjs";

function analysis({ anchors, hasTargetDomain = false }) {
  return {
    domain: {
      hasTargetDomain,
      targetDomains: [],
      unassignedAnchors: anchors,
    },
    quality: { changedFunctions: anchors.map((anchor) => ({ anchor })) },
  };
}

test("asks for a domain when Anatomia found unassigned changed functions", () => {
  const instruction = domainInstruction({ analysis: analysis({ anchors: ["fn:changed"] }) });
  assert.match(instruction, /Infer the target domain/);
  assert.match(instruction, /PR_GATE_NEEDS_HUMAN/);
});

test("does not invent a function domain for an unsupported executable surface", () => {
  const instruction = domainInstruction({ analysis: analysis({ anchors: [] }) });
  assert.match(instruction, /no analyzable changed functions/);
  assert.match(instruction, /Review the executable script/);
  assert.match(instruction, /Do not invent a code anchor/);
});

test("a docs-only change keeps its own instruction rather than the executable one", () => {
  // Documentation carries no changed functions either, so the two relaxations
  // overlap; the reviewer must be told to check the docs, not a script.
  const instruction = domainInstruction({
    analysis: analysis({ anchors: [] }),
    docsOnly: true,
  });
  assert.match(instruction, /documentation files only/);
  assert.match(instruction, /documentation stays consistent/);
  assert.doesNotMatch(instruction, /Review the executable script/);
});

test("a config-only change keeps its own instruction rather than the executable one", () => {
  const instruction = domainInstruction({
    analysis: analysis({ anchors: [] }),
    docsOnly: false,
    docsOrConfigOnly: true,
  });
  assert.match(instruction, /documentation and configuration files only/);
  assert.doesNotMatch(instruction, /Review the executable script/);
});
