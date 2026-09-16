import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { contract } from './contract-runtime.mjs'; /* augur-inject:import:72423411 */
import augurContract_8c66588f from '../contracts/experience-evidence-for-review-report.contract.mjs'; /* augur-inject:contract-predicate:e67bb4cc */

function recordsFromJson(text) {
  const value = JSON.parse(text);
  return Array.isArray(value) ? value : [value];
}

function storedRuns(worktreePath, { exists = existsSync, list = readdirSync, read = readFileSync } = {}) {
  const directory = join(worktreePath, ".augur", "runs");
  const jsonl = join(worktreePath, ".augur", "runs.jsonl");
  const paths = exists(directory)
    ? list(directory).map((name) => join(directory, name))
    : exists(jsonl) ? [jsonl] : [];
  try {
    return paths.flatMap((path) => read(path, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return recordsFromJson(line); } catch { return []; }
    }));
  } catch {
    return [];
  }
}

export function experienceEvidenceFor({ worktreePath, headSha, runIds = [] }, dependencies) {
  const ids = new Set(runIds.filter((id) => typeof id === "string"));
  const runs = storedRuns(worktreePath, dependencies).filter((run) => (
    run?.headSha === headSha && (ids.size === 0 || ids.has(run.runId))
  ));
  const evidence = runs.flatMap((run) => Array.isArray(run.evidence) ? run.evidence : []);
  return evidence.length > 0
    ? { status: "recorded", count: evidence.length }
    : { status: "unverified", count: 0 };
}
// @ts-expect-error augur-inject
experienceEvidenceFor = contract(experienceEvidenceFor, { ...augurContract_8c66588f, contractId: 'C-10', mode: 'observe', sample: 1, where: 'src/augur-evidence.mjs:24', rule: 'contract-wrap', id: '8c66588f' }); /* augur-inject:contract-wrap:8c66588f */
