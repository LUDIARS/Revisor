import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { digestOf, sha256Hex } from "../src/cloud-build/canonical.mjs";
import { classifyResult } from "../src/cloud-build/classify.mjs";
import { runCloudBuildCommand } from "../src/cloud-build/command.mjs";
import { buildInputManifest } from "../src/cloud-build/input-manifest.mjs";
import { normalizeInputPath } from "../src/cloud-build/input-policy.mjs";
import { buildRequest } from "../src/cloud-build/request.mjs";

const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const NOW = new Date("2026-11-21T00:00:00.000Z");
const WINDOWS = { os: "windows", arch: "x64", toolchain: { name: "msvc", version: "19.50" }, cmake: "4.4.4" };

function sampleRequest(overrides = {}) {
  return buildRequest({
    pullRequestId: "fb0a2ccf",
    pullRequestNumber: 3786,
    repository: "LUDIARS/Figmentum",
    headSha: HEAD,
    runId: "run1",
    shardIndex: 0,
    shardCount: 1,
    tests: ["configure", "build"],
    environment: WINDOWS,
    inputs: [{ path: "CMakeLists.txt", size: 3, sha256: "c".repeat(64), gitBlob: "d".repeat(40) }],
    ...overrides,
  }, { now: NOW, nonce: "e".repeat(32) }).request;
}

function sampleResult(request, log, overrides = {}) {
  return {
    schema: "revisor.cloud-build.result/1",
    requestId: request.requestId,
    shardId: request.shardId,
    headSha: request.headSha,
    requestDigest: digestOf(request),
    nonce: request.nonce,
    status: "passed",
    exitCode: 0,
    durationMs: 538_000,
    startedAt: "2026-11-21T01:00:00.000Z",
    finishedAt: "2026-11-21T01:08:58.000Z",
    environment: WINDOWS,
    tests: [{ name: "configure", status: "passed", exitCode: 0 }, { name: "build", status: "passed", exitCode: 0 }],
    log: { file: "log.txt", sha256: sha256Hex(log), size: log.length },
    ...overrides,
  };
}

const LOG = Buffer.from("build ok\n");

test("accepts a result that matches its request and records executor-reported evidence", () => {
  const request = sampleRequest();
  const verdict = classifyResult({ raw: sampleResult(request, LOG), request, logBytes: LOG });
  assert.equal(verdict.classification, "passed");
  assert.equal(verdict.guarantee, "executor-reported");
  assert.equal(verdict.exitCode, 0);
  assert.equal(verdict.durationMs, 538_000);
  assert.equal(verdict.logSha256, sha256Hex(LOG));
});

test("keeps a real failure as failed and an unexecuted shard as not_executed", () => {
  const request = sampleRequest();
  const failed = sampleResult(request, LOG, {
    status: "failed", exitCode: 1,
    tests: [{ name: "configure", status: "passed" }, { name: "build", status: "failed", exitCode: 1 }],
  });
  assert.equal(classifyResult({ raw: failed, request, logBytes: LOG }).classification, "failed");
  const skipped = sampleResult(request, LOG, {
    status: "not_executed", exitCode: undefined,
    tests: [{ name: "configure", status: "not_executed" }, { name: "build", status: "not_executed" }],
  });
  assert.equal(classifyResult({ raw: skipped, request, logBytes: LOG }).classification, "not_executed");
});

const REJECTIONS = [
  ["unknown_request", (request) => ({ raw: sampleResult(request, LOG), request: null, logBytes: LOG })],
  ["request_digest_mismatch", (request) => ({ raw: sampleResult(request, LOG, { requestDigest: "0".repeat(64) }), request, logBytes: LOG })],
  ["nonce_mismatch", (request) => ({ raw: sampleResult(request, LOG, { nonce: "f".repeat(32) }), request, logBytes: LOG })],
  ["head_mismatch", (request) => ({ raw: sampleResult(request, LOG, { headSha: OTHER_HEAD }), request, logBytes: LOG })],
  ["environment_mismatch", (request) => ({
    raw: sampleResult(request, LOG, { environment: { os: "linux", arch: "x64", toolchain: { name: "gcc", version: "14" }, cmake: "4.4.4" } }),
    request, logBytes: LOG,
  })],
  ["log_missing", (request) => ({ raw: sampleResult(request, LOG), request, logBytes: null })],
  ["log_hash_mismatch", (request) => ({ raw: sampleResult(request, LOG), request, logBytes: Buffer.from("edited\n") })],
  ["stale", (request) => ({ raw: sampleResult(request, LOG, { finishedAt: "2026-11-23T00:00:00.000Z" }), request, logBytes: LOG })],
  ["test_set_mismatch", (request) => ({
    raw: sampleResult(request, LOG, { tests: [{ name: "configure", status: "passed" }] }), request, logBytes: LOG,
  })],
  ["inconsistent_status", (request) => ({
    raw: sampleResult(request, LOG, { tests: [{ name: "configure", status: "passed" }, { name: "build", status: "failed" }] }),
    request, logBytes: LOG,
  })],
];

for (const [reason, makeInput] of REJECTIONS) {
  test(`rejects a result with ${reason}`, () => {
    const verdict = classifyResult(makeInput(sampleRequest()));
    assert.equal(verdict.classification, "rejected");
    assert.equal(verdict.reason, reason);
  });
}

test("names which environment fields differ, so Linux never stands in for MSVC", () => {
  const request = sampleRequest();
  const raw = sampleResult(request, LOG, { environment: { ...WINDOWS, os: "linux" } });
  assert.equal(classifyResult({ raw, request, logBytes: LOG }).detail, "os");
});

test("treats an identical resend as a duplicate and a different second result as a conflict", () => {
  const request = sampleRequest();
  const first = classifyResult({ raw: sampleResult(request, LOG), request, logBytes: LOG });
  const again = classifyResult({ raw: sampleResult(request, LOG), request, logBytes: LOG, prior: [first] });
  assert.deepEqual([again.classification, again.reason], ["duplicate", "identical"]);
  const other = classifyResult({ raw: sampleResult(request, LOG, { durationMs: 1 }), request, logBytes: LOG, prior: [first] });
  assert.deepEqual([other.classification, other.reason], ["rejected", "conflicting_duplicate"]);
});

test("reports malformed results as invalid", () => {
  const verdict = classifyResult({ raw: { schema: "nope" }, request: sampleRequest(), logBytes: LOG });
  assert.equal(verdict.classification, "invalid");
});

test("refuses secrets, databases and paths outside the repository as inputs", () => {
  for (const path of [".env", "config/.env.local", "keys/server.pem", "data/revisor.sqlite", "../outside.txt", "/abs/file", "C:/x", ".git/config"]) {
    assert.throws(() => normalizeInputPath(path), undefined, path);
  }
  assert.equal(normalizeInputPath("src\\main.cpp"), "src/main.cpp");
});

test("refuses to ship a working-tree file that differs from the head", async () => {
  const git = async (_repo, args) => (args[0] === "rev-parse" ? "1".repeat(40) : "2".repeat(40));
  await assert.rejects(
    buildInputManifest({ repo: "repo", headSha: HEAD, paths: ["a.cpp"] }, { git, stat: () => ({ size: 1 }), readFile: () => Buffer.from("x") }),
    /differs from/,
  );
});

function captured() {
  let text = "";
  return { stream: { write: (chunk) => { text += chunk; } }, json: () => JSON.parse(text) };
}

test("round-trips request, outbox, ingest and run status through the CLI", async () => {
  const root = mkdtempSync(join(tmpdir(), "rv-cloud-build-"));
  try {
    const exchange = join(root, "exchange");
    const repo = join(root, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, "CMakeLists.txt"), "abc");
    const buildManifest = async ({ repo: dir, paths }) => paths.map((path) => ({
      path, size: 3, sha256: sha256Hex("abc"), gitBlob: "d".repeat(40), absolute: join(dir, path),
    }));
    const requests = [];
    for (const shard of ["0/2", "1/2"]) {
      const out = captured();
      const code = await runCloudBuildCommand([
        "cloud-build", "request", "--exchange", exchange, "--repo", repo, "--pr", "fb0a2ccf", "--number", "3786",
        "--repository", "LUDIARS/Figmentum", "--head", HEAD, "--run", "run1", "--shard", shard,
        "--test", "build", "--os", "windows", "--arch", "x64", "--toolchain", "msvc@19.50", "--cmake", "4.4.4",
        "--input", "CMakeLists.txt",
      ], { stdout: out.stream, now: () => NOW, buildManifest });
      assert.equal(code, 0);
      requests.push(out.json());
    }
    const outboxRequest = JSON.parse(readFileSync(join(requests[0].outbox, "request.json"), "utf8"));
    assert.equal(readFileSync(join(requests[0].outbox, "inputs", "CMakeLists.txt"), "utf8"), "abc");

    const status = async () => {
      const out = captured();
      await runCloudBuildCommand(["cloud-build", "status", "--exchange", exchange, "--run", "run1", "--head", HEAD], { stdout: out.stream });
      return out.json();
    };
    assert.equal((await status()).state, "partial");

    const resultDir = join(root, "inbox");
    mkdirSync(resultDir);
    writeFileSync(join(resultDir, "log.txt"), LOG);
    const raw = sampleResult(outboxRequest, LOG, { tests: [{ name: "build", status: "passed", exitCode: 0 }] });
    writeFileSync(join(resultDir, "result.json"), JSON.stringify(raw));
    const ingest = captured();
    assert.equal(await runCloudBuildCommand(["cloud-build", "ingest", "--exchange", exchange, "--result", resultDir], { stdout: ingest.stream }), 0);
    assert.equal(ingest.json().classification, "passed");

    const partial = await status();
    assert.equal(partial.state, "partial");
    assert.deepEqual(partial.shards.map((shard) => shard.outcome), ["passed", "missing"]);

    // A Linux result for the second (Windows) shard is refused and does not complete the run.
    const second = JSON.parse(readFileSync(join(requests[1].outbox, "request.json"), "utf8"));
    writeFileSync(join(resultDir, "result.json"), JSON.stringify(sampleResult(second, LOG, {
      tests: [{ name: "build", status: "passed", exitCode: 0 }],
      environment: { os: "linux", arch: "x64", toolchain: { name: "gcc", version: "14" } },
    })));
    const linux = captured();
    assert.equal(await runCloudBuildCommand(["cloud-build", "ingest", "--exchange", exchange, "--result", resultDir], { stdout: linux.stream }), 2);
    assert.equal(linux.json().reason, "environment_mismatch");
    assert.equal((await status()).state, "partial");

    writeFileSync(join(resultDir, "result.json"), JSON.stringify(sampleResult(second, LOG, {
      tests: [{ name: "build", status: "passed", exitCode: 0 }],
    })));
    assert.equal(await runCloudBuildCommand(["cloud-build", "ingest", "--exchange", exchange, "--result", resultDir], { stdout: captured().stream }), 0);
    assert.equal((await status()).state, "complete");

    const otherHead = captured();
    await runCloudBuildCommand(["cloud-build", "status", "--exchange", exchange, "--run", "run1", "--head", OTHER_HEAD], { stdout: otherHead.stream });
    assert.equal(otherHead.json().state, "unknown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses to overwrite an issued request", async () => {
  const root = mkdtempSync(join(tmpdir(), "rv-cloud-build-"));
  try {
    const args = [
      "cloud-build", "request", "--exchange", join(root, "x"), "--repo", root, "--pr", "p1", "--number", "1",
      "--repository", "o/r", "--head", HEAD, "--run", "r", "--shard", "0/1", "--test", "t",
      "--os", "linux", "--arch", "x64", "--toolchain", "gcc@14", "--input", "f.txt",
    ];
    writeFileSync(join(root, "f.txt"), "1");
    const buildManifest = async ({ paths }) => paths.map((path) => ({ path, size: 1, sha256: "c".repeat(64), gitBlob: "d".repeat(40), absolute: join(root, path) }));
    await runCloudBuildCommand(args, { stdout: captured().stream, now: () => NOW, buildManifest });
    await assert.rejects(runCloudBuildCommand(args, { stdout: captured().stream, now: () => NOW, buildManifest }), /already exists/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
