/**
 * @implements RV-NATIVE-DEPS-03 — the C++ dependency vulnerability check as one registered-check row.
 *
 * Verdict, scoped to what the PR changed (an existing vulnerable pin is the
 * repository's debt, not this PR's):
 *   failed  — a dependency the PR added or re-pinned has a known OSV vulnerability,
 *             or cannot be identified (unresolved CMake variable, undeclared vendored copy)
 *   error   — the PR changed dependencies and OSV or git could not answer (fail closed)
 *   skipped — OSV could not answer but the PR changed no dependency (stated, not hidden)
 *   passed  — otherwise; vulnerabilities in unchanged dependencies are listed as advisories
 *
 * SRP: deciding the row from the two inventories and OSV's answers.
 */
import { changedDependencies, dependencyKey, nativeInventory } from "./inventory.mjs";
import { osvQuery, queryOsv } from "./osv.mjs";
import { commitSource, worktreeSource } from "./tree-source.mjs";

export const NATIVE_DEPS_CHECK_NAME = "C++ dependency vulnerabilities (OSV)";
const OUTPUT_LIMIT = 8000;

function label(dependency) {
  const pin = dependency.revision ?? dependency.version ?? dependency.url ?? "";
  return `${dependencyKey(dependency)}${pin ? `@${pin}` : ""} (${dependency.file})`;
}

function row(status, startedAt, now, extra) {
  return {
    name: NATIVE_DEPS_CHECK_NAME,
    status,
    exitCode: status === "passed" || status === "skipped" ? 0 : status === "failed" ? 1 : 2,
    durationMs: now() - startedAt,
    ...extra,
  };
}

/**
 * Returns the row, or `null` when neither the PR head nor its base has C/C++
 * sources (the check does not apply).
 * @implements RV-NATIVE-DEPS-03
 */
export async function runNativeDependencyCheck(options, {
  headSource = worktreeSource,
  baseSource = commitSource,
  query = queryOsv,
  now = () => Date.now(),
} = {}) {
  const startedAt = now();
  const { worktreePath, mergeBase } = options;
  let head;
  let base = null;
  try {
    head = await nativeInventory(headSource(worktreePath));
    if (mergeBase) base = await nativeInventory(baseSource(worktreePath, mergeBase));
  } catch {
    await options.onCheckStarted?.({ name: NATIVE_DEPS_CHECK_NAME });
    return row("error", startedAt, now, { reason: "the C++ dependency inventory could not be read from git" });
  }
  if (head === null && base === null) return null;
  await options.onCheckStarted?.({ name: NATIVE_DEPS_CHECK_NAME });
  const dependencies = head ?? [];
  // Without a merge base nothing can be called unchanged: every dependency is the PR's.
  const changed = new Set(changedDependencies(dependencies, mergeBase ? base ?? [] : null));

  const queryable = dependencies.map((dependency) => ({ dependency, query: osvQuery(dependency) })).filter((entry) => entry.query);
  let answers;
  try {
    answers = await query(queryable.map((entry) => entry.query));
  } catch {
    const changedQueryable = queryable.some((entry) => changed.has(entry.dependency));
    return changedQueryable
      ? row("error", startedAt, now, { reason: "OSV could not be queried for the dependencies this PR changed" })
      : row("skipped", startedAt, now, { reason: "OSV could not be queried; this PR changed no queryable C++ dependency" });
  }

  const vulnerable = queryable.map((entry, index) => ({ ...entry, ids: answers[index] ?? [] })).filter((entry) => entry.ids.length > 0);
  const blocking = vulnerable.filter((entry) => changed.has(entry.dependency));
  const unidentified = [...changed].filter((dependency) => dependency.unresolved);
  const advisoryVulns = vulnerable.filter((entry) => !changed.has(entry.dependency));
  const advisoryUnresolved = dependencies.filter((dependency) => dependency.unresolved && !changed.has(dependency));

  const lines = [
    ...blocking.map((entry) => `blocking: ${label(entry.dependency)}: ${entry.ids.join(", ")}`),
    ...unidentified.map((dependency) => `blocking: ${label(dependency)}: cannot identify (${dependency.unresolved})`),
    ...advisoryVulns.map((entry) => `existing: ${label(entry.dependency)}: ${entry.ids.join(", ")}`),
    ...advisoryUnresolved.map((dependency) => `unverified: ${label(dependency)}: ${dependency.unresolved}`),
  ];
  const failed = blocking.length > 0 || unidentified.length > 0;
  const result = row(failed ? "failed" : "passed", startedAt, now, {
    nativeDependencies: {
      total: dependencies.length,
      changed: changed.size,
      queried: queryable.length,
      blockingVulnerable: blocking.length,
      blockingUnidentified: unidentified.length,
      existingVulnerable: advisoryVulns.length,
      unverified: advisoryUnresolved.length,
    },
    reason: failed
      ? `${blocking.length} changed C++ dependenc${blocking.length === 1 ? "y has" : "ies have"} known vulnerabilities; ${unidentified.length} cannot be identified`
      : undefined,
  });
  if (lines.length > 0) {
    const text = lines.join("\n");
    result.output = { text: text.slice(0, OUTPUT_LIMIT), truncated: text.length > OUTPUT_LIMIT };
  }
  return result;
}
