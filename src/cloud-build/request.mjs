import { randomBytes } from "node:crypto";
import { digestOf } from "./canonical.mjs";
import { parseEnvironment } from "./environment.mjs";
import { assertInputSize, normalizeInputPath } from "./input-policy.mjs";

export const REQUEST_SCHEMA = "revisor.cloud-build.request/1";
const ID_PATTERN = /^[A-Za-z0-9._-]{1,80}$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const HOUR_MS = 60 * 60 * 1000;

function requireId(value, label) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw new Error(`${label} must match ${ID_PATTERN}.`);
  return value;
}

function parseShard(index, count) {
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error("shard count must be 1..1000.");
  if (!Number.isInteger(index) || index < 0 || index >= count) throw new Error("shard index must be 0..count-1.");
  return { index, count };
}

function parseTests(tests) {
  if (!Array.isArray(tests) || tests.length === 0) throw new Error("at least one test is required.");
  const names = tests.map((name) => {
    if (typeof name !== "string" || !name.trim()) throw new Error("test names must be non-empty strings.");
    return name.trim();
  });
  if (new Set(names).size !== names.length) throw new Error("test names must be unique.");
  return names;
}

function parseInputs(inputs) {
  if (!Array.isArray(inputs) || inputs.length === 0) throw new Error("at least one input file is required.");
  const parsed = inputs.map((input) => {
    const path = normalizeInputPath(input.path);
    assertInputSize(path, input.size);
    if (!/^[0-9a-f]{64}$/.test(input.sha256 ?? "")) throw new Error(`input '${path}' needs a sha256.`);
    if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(input.gitBlob ?? "")) throw new Error(`input '${path}' needs a git blob id.`);
    return { path, size: input.size, sha256: input.sha256, gitBlob: input.gitBlob };
  }).sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  for (let index = 1; index < parsed.length; index += 1) {
    if (parsed[index].path === parsed[index - 1].path) throw new Error(`input '${parsed[index].path}' is listed twice.`);
  }
  return parsed;
}

export function requestIdFor({ pullRequestId, headSha, runId, shardId }) {
  return `${pullRequestId.slice(0, 12)}-${headSha.slice(0, 12)}-${runId}-${shardId}`.slice(0, 120);
}

/**
 * Builds the request an external executor receives.  Inputs arrive already
 * hashed (see input-manifest.mjs) so this stays a pure function.
 */
export function buildRequest(params, { now = new Date(), nonce = randomBytes(16).toString("hex") } = {}) {
  const pullRequestId = requireId(params.pullRequestId, "pull request id");
  if (!Number.isInteger(params.pullRequestNumber) || params.pullRequestNumber < 1) {
    throw new Error("pull request number must be a positive integer.");
  }
  if (typeof params.repository !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(params.repository)) {
    throw new Error("repository must be owner/name.");
  }
  if (!SHA_PATTERN.test(params.headSha ?? "")) throw new Error("head must be a 40-digit lowercase hex sha.");
  const runId = requireId(params.runId, "run id");
  const shard = parseShard(params.shardIndex, params.shardCount);
  const shardId = `${shard.index + 1}of${shard.count}`;
  const ttlHours = params.ttlHours ?? 24;
  if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 24 * 14) throw new Error("ttl hours must be within 0..336.");
  const request = {
    schema: REQUEST_SCHEMA,
    requestId: requestIdFor({ pullRequestId, headSha: params.headSha, runId, shardId }),
    pullRequest: { id: pullRequestId, number: params.pullRequestNumber, repository: params.repository },
    headSha: params.headSha,
    runId,
    shardId,
    shard,
    tests: parseTests(params.tests),
    environment: parseEnvironment(params.environment),
    inputs: parseInputs(params.inputs),
    nonce,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlHours * HOUR_MS).toISOString(),
  };
  return { request, requestDigest: digestOf(request) };
}
