// A registered case that prepares the review checkout (dependencies, submodules,
// build configuration) rather than testing it. The Augur domain-bundle route runs
// only these before the bundles: the review checkout is a fresh clone with no
// node_modules, so skipping them makes every bundle fail to start its runner
// (MODULE_NOT_FOUND) and read as "未実行" instead of as a result.
const SETUP_CASE_NAME = /^(?:bootstrap|restore|configure|submodules|setup(?:-.+)?|install(?:-.+)?|.+-install)$/i;

/** Registered cases, in their registered order, that prepare the checkout. */
export function setupTestCases(testCases) {
  return (Array.isArray(testCases) ? testCases : [])
    .filter((testCase) => typeof testCase?.name === "string" && SETUP_CASE_NAME.test(testCase.name.trim()));
}

/**
 * Runs the setup cases one at a time and stops at the first failure: a later
 * step (or the bundles) would only fail again for the same missing preparation.
 */
export async function runSetupTestCases({ testCases, runCase }) {
  const results = [];
  for (const testCase of testCases) {
    const [result] = await runCase(testCase);
    results.push({ ...result, setup: true });
    if (result.status !== "passed") return { results, ok: false };
  }
  return { results, ok: true };
}
