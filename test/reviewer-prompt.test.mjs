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

test("does not invent an application domain for parseable test helpers", () => {
  const instruction = domainInstruction({
    analysis: analysis({ anchors: ["test:catalog"] }),
    codeDomainRequired: false,
  });
  assert.match(instruction, /no production code/);
  assert.match(instruction, /tests or operational files/);
  assert.match(instruction, /do not report PR_GATE_NEEDS_HUMAN/i);
  assert.doesNotMatch(instruction, /Infer the target domain/);
});

test("a docs/config-only change keeps its wording over the generic non-code one", () => {
  // Every docs/config-only change is also a non-code change, so the two
  // relaxations overlap; the reviewer must get the more specific instruction.
  const instruction = domainInstruction({
    analysis: analysis({ anchors: [] }),
    docsOnly: false,
    docsOrConfigOnly: true,
    codeDomainRequired: false,
  });
  assert.match(instruction, /documentation and configuration files only/);
  assert.doesNotMatch(instruction, /no production code/);
});
