/** @implements RV-PRAESIDIUM-01 — distinguish JS evaluation from same-named service methods. */
export function isJavaScriptEvaluation(code, match) {
  const before = code.slice(0, match.index);
  // A TS parameter declaration cannot be a JavaScript call expression. This includes
  // typed interface signatures and test doubles; object/ternary arguments do not match.
  const parameters = code.slice(match.index + match[0].length);
  if (/^\s*(?:\.\.\.)?[A-Za-z_$][\w$]*\s*:\s*/.test(parameters)) return false;
  if (!/\.\s*$/.test(before)) return true;
  // Keep explicitly qualified built-ins covered. Arbitrary object methods (e.g.
  // Redis.eval) do not invoke the JS evaluator. Alias tracking is outside this
  // syntactic rule's documented coverage and remains a separate review concern.
  return /\b(?:globalThis|window|self|global)\s*(?:\?\.|\.)\s*$/.test(before);
}
