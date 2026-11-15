/** Two compiler workers share a bounded budget sized for every configured compiler process. */
import { NATIVE_WORKERS, nativeSchedulingBudget } from "./native-limits.mjs";

// Each invocation runs its passes in order (diagnostics, expansion, analyzer); a pass that
// does not pass ends the unit, because its status can no longer become "passed". A
// `probe` invocation's first pass only asks whether the compiler reads the file at all:
// when it does not, the file is reported as not analyzed instead of failed. When such an
// invocation's diagnostics pass fails, its `syntax` checks ask whether the file is
// Objective-C without an `@`: it does not parse in its unit's language even without
// warnings, and does parse as Objective-C. Then it is not analyzed either; a file that
// parses in its own language, or in neither, failed. Only exit codes decide.
export async function analyzeNativeBatch(invocations, execute, now = Date.now) {
  const startedAt = now();
  const budgetMs = nativeSchedulingBudget(invocations.reduce((total, invocation) =>
    total + invocation.passes.length + (invocation.syntax?.length ?? 0), 0));
  const overBudget = () => now() - startedAt > budgetMs;
  const outcomes = new Array(invocations.length);
  let next = 0;
  async function worker() {
    while (next < invocations.length) {
      const index = next++;
      const invocation = invocations[index];
      let status = "passed";
      for (const [pass, args] of invocation.passes.entries()) {
        if (overBudget()) {
          outcomes[index] = { rule: "native.analysis-budget", file: invocation.file, status: "error" };
          break;
        }
        status = await passStatus(invocation, args, execute);
        if (status === "failed" && invocation.probe && pass === 1 && invocation.syntax) {
          status = await syntaxVerdict(invocation, execute, overBudget);
        }
        if (status === "budget") outcomes[index] = { rule: "native.analysis-budget", file: invocation.file, status: "error" };
        if ((status === "failed" && invocation.probe && pass === 0) || status === "skipped") {
          outcomes[index] = { rule: "native.not-analyzed", file: invocation.file, status: "skipped" };
        }
        if (status !== "passed") break;
      }
      outcomes[index] ??= { rule: "native.clang-analysis", file: invocation.file, status };
    }
  }
  await Promise.all(Array.from({ length: Math.min(NATIVE_WORKERS, invocations.length) }, () => worker()));
  return outcomes;
}

async function passStatus(invocation, args, execute) {
  let result;
  try { result = await execute(invocation.command, args, invocation.cwd); }
  catch { result = { ok: false, exitCode: null }; /* Execution failure is an explicit incomplete check. */ }
  return result?.ok && !result.diagnostics ? "passed" : result?.exitCode == null ? "error" : "failed";
}

// "skipped" when the file parses only as Objective-C, "failed" when it parses in its own
// language or in neither, "error" when a check could not run, "budget" past the budget.
async function syntaxVerdict(invocation, execute, overBudget) {
  const [own, objectiveC] = invocation.syntax;
  for (const [args, parses] of [[own, false], [objectiveC, true]]) {
    if (overBudget()) return "budget";
    const status = await passStatus(invocation, args, execute);
    if (status === "error") return "error";
    if ((status === "passed") !== parses) return "failed";
  }
  return "skipped";
}
