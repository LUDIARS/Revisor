// Partial verification runs the registered tests before it re-runs Anatomia, so
// when Anatomia is itself a target the fresh analysis does not exist yet. The
// test selection then uses the previous review's domains — the PR's changed
// domains, which a base merge or an autofix does not move — instead of reading
// `null.domain` and failing the whole review ("Cannot read properties of null").

/** Target domains for the registered-test run of a partial verification. */
export function verificationTestDomains(currentAnalysis, previousAnalysis) {
  const source = currentAnalysis ?? previousAnalysis;
  const domains = source?.domain?.targetDomains;
  if (!Array.isArray(domains)) {
    throw new Error("Partial verification requires the previous Anatomia result to select registered tests.");
  }
  return domains;
}
