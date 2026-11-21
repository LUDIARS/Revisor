import { parseEnvironment } from "./environment.mjs";

export const RESULT_SCHEMA = "revisor.cloud-build.result/1";
const STATUSES = new Set(["passed", "failed", "not_executed"]);

function isoTime(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO time.`);
  return value;
}

function nonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`);
  return value;
}

function parseTestResult(value, index) {
  if (!value || typeof value.name !== "string" || !value.name.trim()) throw new Error(`tests[${index}].name is required.`);
  if (!STATUSES.has(value.status)) throw new Error(`tests[${index}].status is invalid.`);
  if (value.exitCode !== undefined && !Number.isInteger(value.exitCode)) throw new Error(`tests[${index}].exitCode must be an integer.`);
  return {
    name: value.name.trim(),
    status: value.status,
    ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode }),
    ...(value.durationMs === undefined ? {} : { durationMs: nonNegativeInteger(value.durationMs, `tests[${index}].durationMs`) }),
  };
}

/** Structural validation only; agreement with the request is checked by classify. */
export function parseResult(value) {
  if (!value || typeof value !== "object") throw new Error("result must be an object.");
  if (value.schema !== RESULT_SCHEMA) throw new Error(`result.schema must be ${RESULT_SCHEMA}.`);
  for (const key of ["requestId", "shardId", "headSha", "requestDigest", "nonce"]) {
    if (typeof value[key] !== "string" || !value[key]) throw new Error(`result.${key} is required.`);
  }
  if (!STATUSES.has(value.status)) throw new Error("result.status must be passed, failed or not_executed.");
  if (value.status !== "not_executed" && !Number.isInteger(value.exitCode)) {
    throw new Error("result.exitCode is required unless the shard was not executed.");
  }
  if (value.exitCode !== undefined && value.exitCode !== null && !Number.isInteger(value.exitCode)) {
    throw new Error("result.exitCode must be an integer.");
  }
  if (!Array.isArray(value.tests)) throw new Error("result.tests must be an array.");
  const log = value.log;
  if (!log || typeof log.file !== "string" || !/^[A-Za-z0-9._-]{1,120}$/.test(log.file)
    || !/^[0-9a-f]{64}$/.test(log.sha256 ?? "")) {
    throw new Error("result.log needs a plain file name and sha256.");
  }
  return {
    schema: value.schema,
    requestId: value.requestId,
    shardId: value.shardId,
    headSha: value.headSha,
    requestDigest: value.requestDigest,
    nonce: value.nonce,
    status: value.status,
    exitCode: Number.isInteger(value.exitCode) ? value.exitCode : null,
    durationMs: nonNegativeInteger(value.durationMs, "result.durationMs"),
    startedAt: isoTime(value.startedAt, "result.startedAt"),
    finishedAt: isoTime(value.finishedAt, "result.finishedAt"),
    environment: parseEnvironment(value.environment, "result.environment"),
    tests: value.tests.map(parseTestResult),
    log: { file: log.file, sha256: log.sha256, size: nonNegativeInteger(log.size, "result.log.size") },
  };
}
