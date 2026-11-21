/**
 * `revisor cloud-build request|ingest|status` — 外部実行環境との依頼・結果の受渡し。
 * 転送と外部起動は行わない (spec/feature/cloud-build-exchange.md)。
 */
import { resolve } from "node:path";
import { option } from "../local-pr-commands.mjs";
import { classifyResult } from "./classify.mjs";
import { archiveResult, loadAllRequests, loadRequest, readResultDir, writeOutbox } from "./exchange-files.mjs";
import { buildInputManifest } from "./input-manifest.mjs";
import { appendLedger, readLedger, summarizeRun } from "./ledger.mjs";
import { buildRequest } from "./request.mjs";

function required(args, name) {
  const value = option(args, name);
  if (value === null) throw new Error(`${name} is required.`);
  return value;
}

function repeated(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value.`);
    values.push(value);
  }
  return values;
}

function parseShardOption(value) {
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match) throw new Error("--shard must be <index>/<count> (index starts at 0).");
  return { shardIndex: Number(match[1]), shardCount: Number(match[2]) };
}

function parseToolchain(value) {
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) throw new Error("--toolchain must be <name>@<version>.");
  return { name: value.slice(0, at), version: value.slice(at + 1) };
}

async function requestCommand(args, { now, buildManifest }) {
  const exchange = resolve(required(args, "--exchange"));
  const repo = resolve(required(args, "--repo"));
  const headSha = required(args, "--head");
  const cmake = option(args, "--cmake");
  const ttl = option(args, "--ttl-hours");
  const inputs = await buildManifest({ repo, headSha, paths: repeated(args, "--input") });
  const { request, requestDigest } = buildRequest({
    pullRequestId: required(args, "--pr"),
    pullRequestNumber: Number(required(args, "--number")),
    repository: required(args, "--repository"),
    headSha,
    runId: required(args, "--run"),
    ...parseShardOption(required(args, "--shard")),
    tests: repeated(args, "--test"),
    environment: {
      os: required(args, "--os"),
      arch: required(args, "--arch"),
      toolchain: parseToolchain(required(args, "--toolchain")),
      ...(cmake === null ? {} : { cmake }),
    },
    inputs,
    ...(ttl === null ? {} : { ttlHours: Number(ttl) }),
  }, { now: now() });
  const outbox = writeOutbox(exchange, request, inputs);
  return { code: 0, body: { requestId: request.requestId, requestDigest, outbox, inputs: request.inputs.length, expiresAt: request.expiresAt } };
}

function ingestCommand(args) {
  const exchange = resolve(required(args, "--exchange"));
  const received = readResultDir(resolve(required(args, "--result")));
  const requestId = typeof received.raw?.requestId === "string" ? received.raw.requestId : null;
  const prior = readLedger(exchange).filter((record) => record.requestId === requestId);
  const verdict = classifyResult({
    raw: received.raw,
    request: requestId ? loadRequest(exchange, requestId) : null,
    logBytes: received.logBytes,
    prior,
  });
  const archivedAt = archiveResult(exchange, requestId, received);
  const record = { recordedAt: new Date().toISOString(), ...verdict, archivedAt };
  // An identical duplicate is reported but not recorded a second time.
  if (verdict.classification !== "duplicate") appendLedger(exchange, record);
  const code = verdict.classification === "invalid" || verdict.classification === "rejected" ? 2 : 0;
  return { code, body: record };
}

function statusCommand(args) {
  const exchange = resolve(required(args, "--exchange"));
  return {
    code: 0,
    body: summarizeRun(readLedger(exchange), loadAllRequests(exchange), {
      runId: required(args, "--run"),
      headSha: required(args, "--head"),
    }),
  };
}

export async function runCloudBuildCommand(args, {
  stdout = process.stdout,
  now = () => new Date(),
  buildManifest = buildInputManifest,
} = {}) {
  if (args[0] !== "cloud-build") return null;
  const sub = args[1];
  const rest = args.slice(2);
  let outcome;
  if (sub === "request") outcome = await requestCommand(rest, { now, buildManifest });
  else if (sub === "ingest") outcome = ingestCommand(rest);
  else if (sub === "status") outcome = statusCommand(rest);
  else throw new Error("usage: revisor cloud-build <request|ingest|status> ...");
  stdout.write(`${JSON.stringify(outcome.body, null, 2)}\n`);
  return outcome.code;
}
