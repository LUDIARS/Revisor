/** @implements RV-PRAESIDIUM-01 — distinguish JS evaluation from same-named service methods. */

// The index before the whitespace that ends at `index`. Each match walks back only over
// the whitespace in front of its own tokens, and those runs never overlap between
// matches, so the rule stays linear in the file size however many calls share a line.
function skipSpaceBackward(code, index) {
  let at = index;
  while (at > 0 && /\s/.test(code[at - 1])) at--;
  return at;
}

const GLOBAL_RECEIVER = /\b(?:globalThis|window|self|global)$/;
// Long enough for `globalThis` and the character before it, which decides the `\b`.
const GLOBAL_RECEIVER_LENGTH = 11;

export function isJavaScriptEvaluation(code, match) {
  // A TS parameter declaration cannot be a JavaScript call expression. This includes
  // typed interface signatures and test doubles; object/ternary arguments do not match.
  const parameters = code.slice(match.index + match[0].length);
  if (/^\s*(?:\.\.\.)?[A-Za-z_$][\w$]*\s*:\s*/.test(parameters)) return false;
  let end = skipSpaceBackward(code, match.index);
  if (code[end - 1] !== ".") return true;
  // Keep explicitly qualified built-ins covered, also through `?.`. Arbitrary object
  // methods (e.g. Redis.eval) do not invoke the JS evaluator. Alias tracking is outside
  // this syntactic rule's documented coverage and remains a separate review concern.
  end--;
  if (code[end - 1] === "?") end--;
  end = skipSpaceBackward(code, end);
  return GLOBAL_RECEIVER.test(code.slice(Math.max(0, end - GLOBAL_RECEIVER_LENGTH), end));
}
