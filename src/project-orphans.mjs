import { runProcess } from "./process.mjs";

/** @implements SPEC-REFACTORING-PROPOSAL
 * Collect the uncapped whole-project orphan count for advisory use only.
 */
export async function analyzeProjectOrphans({ cliPath, cwd, env, run = runProcess }) {
  try {
    const result = await run({
      command: process.execPath,
      args: [cliPath, "review", "--repo", cwd, "--json"],
      cwd,
      env,
      timeoutMs: 10 * 60_000,
    });
    if (!result.ok) return { status: "unavailable", reason: "Project orphan analysis did not complete" };
    const report = JSON.parse(result.stdout);
    const count = report?.summary?.orphans;
    if (!Number.isSafeInteger(count) || count < 0) {
      return { status: "unavailable", reason: "Project orphan analysis returned no usable count" };
    }
    // The detail array is capped by Anatomia. Only summary.orphans is a census.
    return { status: "measured", scope: "project", count };
  } catch {
    // An advisory measurement failure must not become a merge failure or expose CLI output.
    return { status: "unavailable", reason: "Project orphan analysis returned no usable result" };
  }
}
