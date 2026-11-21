import { digestOf, sha256Hex } from "./canonical.mjs";
import { environmentMismatches } from "./environment.mjs";
import { parseResult } from "./result-shape.mjs";

export const GUARANTEE = "executor-reported";
const ACCEPTED = new Set(["passed", "failed", "not_executed"]);

function rejected(reason, detail) {
  return { classification: "rejected", reason, ...(detail ? { detail } : {}) };
}

function sameNames(left, right) {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

function outcomeOf(result) {
  if (result.status === "not_executed") return { classification: "not_executed" };
  const anyFailed = result.tests.some((test) => test.status !== "passed")
    || result.exitCode !== 0
    || result.tests.some((test) => test.exitCode !== undefined && test.exitCode !== 0);
  if (result.status === "passed" && anyFailed) {
    return rejected("inconsistent_status", "status passed with a failing test or non-zero exit");
  }
  return { classification: result.status === "passed" ? "passed" : "failed" };
}

/**
 * Decides what an incoming result proves.  The order matters: identity checks
 * (which request, which head, which environment) come before integrity and
 * freshness, and only a result that survives all of them counts as executed.
 *
 * `request` is the stored request (null when unknown); `prior` holds the ledger
 * records already accepted for the same requestId.
 */
export function classifyResult({ raw, request, logBytes, prior = [] }) {
  let result;
  try {
    result = parseResult(raw);
  } catch (error) {
    return { classification: "invalid", reason: "invalid_shape", detail: error.message };
  }
  const resultDigest = digestOf(result);
  const base = { requestId: result.requestId, shardId: result.shardId, headSha: result.headSha, resultDigest, guarantee: GUARANTEE };
  const decide = (verdict) => ({ ...base, ...verdict });

  if (!request) return decide(rejected("unknown_request"));
  if (result.requestDigest !== digestOf(request)) return decide(rejected("request_digest_mismatch"));
  if (result.nonce !== request.nonce || result.shardId !== request.shardId) return decide(rejected("nonce_mismatch"));
  if (result.headSha !== request.headSha) return decide(rejected("head_mismatch"));
  const mismatches = environmentMismatches(request.environment, result.environment);
  if (mismatches.length) return decide(rejected("environment_mismatch", mismatches.join(",")));
  if (!logBytes) return decide(rejected("log_missing"));
  const logSha256 = sha256Hex(logBytes);
  if (logSha256 !== result.log.sha256 || logBytes.length !== result.log.size) return decide(rejected("log_hash_mismatch"));
  const finished = Date.parse(result.finishedAt);
  if (finished > Date.parse(request.expiresAt) || finished < Date.parse(request.issuedAt)
    || Date.parse(result.startedAt) > finished) {
    return decide(rejected("stale"));
  }
  if (!sameNames(result.tests.map((test) => test.name), request.tests)) return decide(rejected("test_set_mismatch"));

  const earlier = prior.find((record) => ACCEPTED.has(record.classification));
  if (earlier) {
    return earlier.resultDigest === resultDigest && earlier.logSha256 === logSha256
      ? decide({ classification: "duplicate", reason: "identical" })
      : decide(rejected("conflicting_duplicate"));
  }
  return decide({
    ...outcomeOf(result),
    runId: request.runId,
    status: result.status,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    logSha256,
    environment: result.environment,
  });
}
