import assert from "node:assert/strict";
import test from "node:test";
import { createServiceLog, resolveLogDirectory } from "../src/service-log.mjs";

function collector() {
  const lines = [];
  return { lines, stream: { write: (line) => lines.push(line) } };
}

test("writes under the log root Excubitor injects", () => {
  assert.equal(
    resolveLogDirectory({ VESTIGIUM_LOGS_DIR: "E:\\logs" }).replaceAll("\\", "/"),
    "E:/logs/revisor",
  );
  assert.equal(
    resolveLogDirectory({ REVISOR_LOG_DIR: "E:\\other" }).replaceAll("\\", "/"),
    "E:/other/revisor",
  );
  assert.equal(
    resolveLogDirectory({
      VESTIGIUM_LOGS_DIR: "E:\\logs",
      REVISOR_LOG_DIR: "E:\\override",
    }).replaceAll("\\", "/"),
    "E:/override/revisor",
  );
  assert.equal(resolveLogDirectory({}), null);
});

test("records one JSON object per line in a dated file and on stderr", () => {
  const { lines, stream } = collector();
  const appended = [];
  const directories = [];
  const log = createServiceLog({
    env: { VESTIGIUM_LOGS_DIR: "E:\\logs" },
    clock: () => Date.parse("2026-08-09T01:02:03.000Z"),
    append: (path, line, options) => appended.push([path, line, options]),
    makeDirectory: (path, options) => directories.push([path, options]),
    stream,
  });

  log("merge_conflict_detected", { number: 12, conflictFiles: ["src/a.mjs"] }, { level: "warn" });

  const record = JSON.parse(lines[0]);
  assert.equal(record.event, "merge_conflict_detected");
  assert.equal(record.level, "warn");
  assert.equal(record.service, "revisor");
  assert.equal(record.number, 12);
  assert.deepEqual(record.conflictFiles, ["src/a.mjs"]);
  assert.equal(record.timestamp, "2026-08-09T01:02:03.000Z");
  assert.match(appended[0][0].replaceAll("\\", "/"), /E:\/logs\/revisor\/2026-08-09\.jsonl$/);
  assert.equal(appended[0][1], lines[0]);
  assert.deepEqual(appended[0][2], { encoding: "utf8", mode: 0o600 });
  assert.equal(directories[0][1].mode, 0o700);
});

test("redacts secrets and bounds free-form text", () => {
  const { lines, stream } = collector();
  const log = createServiceLog({ env: {}, stream });

  log("merge_attempt_started", {
    gitMessage: "Authorization: Basic c2VjcmV0\nfatal: conflict",
    long: "x".repeat(5_000),
    token: "another-opaque-value",
    nested: [
      "Authorization: Bearer nested-secret",
      {
        accessToken: "opaque-value-not-covered-by-a-provider-pattern",
        remote: "https://user:password@example.invalid/repository.git",
      },
    ],
    service: "attacker-controlled",
  });

  const record = JSON.parse(lines[0]);
  assert.equal(record.gitMessage.includes("c2VjcmV0"), false);
  assert.match(record.gitMessage, /fatal: conflict/);
  assert.match(record.long, /\[truncated 1000 chars\]$/);
  assert.equal(record.token, "[redacted]");
  assert.equal(record.nested[0], "Authorization: [redacted]");
  assert.equal(record.nested[1].accessToken, "[redacted]");
  assert.equal(record.nested[1].remote, "https://[redacted]@example.invalid/repository.git");
  assert.equal(record.service, "revisor");
});

test("keeps serving when a diagnostic value cannot be serialized safely", () => {
  const { lines, stream } = collector();
  const log = createServiceLog({ env: {}, stream });
  const detail = {};
  Object.defineProperty(detail, "message", {
    enumerable: true,
    get: () => {
      throw new Error("hostile getter");
    },
  });

  assert.doesNotThrow(() => log("heartbeat", detail));
  assert.equal(lines.length, 0);
});

test("does not execute diagnostic toJSON hooks during serialization", () => {
  const { lines, stream } = collector();
  const log = createServiceLog({ env: {}, stream });
  let called = false;

  log("heartbeat", {
    payload: {
      toJSON: () => {
        called = true;
        return "forged";
      },
    },
  });

  assert.equal(called, false);
  assert.equal(JSON.parse(lines[0]).payload.toJSON, "[unsupported]");
});

test("bounds the complete JSONL record, not only each individual value", () => {
  const { lines, stream } = collector();
  const log = createServiceLog({ env: {}, stream });
  const detail = Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => [`field${index}`, "x".repeat(4_000)]),
  );

  log("heartbeat", detail);

  const record = JSON.parse(lines[0]);
  assert.ok(Buffer.byteLength(lines[0], "utf8") <= 64 * 1_024);
  assert.ok(record.truncatedRecordBytes > 64 * 1_024);
  assert.equal(Object.hasOwn(record, "field0"), false);
});

test("keeps serving when the log file cannot be written", () => {
  const { lines, stream } = collector();
  const log = createServiceLog({
    env: { VESTIGIUM_LOGS_DIR: "E:\\logs" },
    append: () => {
      throw new Error("EACCES");
    },
    makeDirectory: () => {},
    stream,
  });

  assert.doesNotThrow(() => log("heartbeat", { rssMb: 1 }));
  assert.equal(lines.length, 1);
});

test("keeps writing the file when the supervisor stderr pipe is closed", () => {
  const appended = [];
  const log = createServiceLog({
    env: { VESTIGIUM_LOGS_DIR: "E:\\logs" },
    append: (_path, line) => appended.push(line),
    makeDirectory: () => {},
    stream: { write: () => { throw new Error("EPIPE"); } },
  });

  assert.doesNotThrow(() => log("heartbeat", { rssMb: 1 }));
  assert.equal(appended.length, 1);
});
