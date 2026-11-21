import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Directory layout of an exchange root:
//   outbox/<requestId>/request.json + inputs/<path>   (what leaves the machine)
//   requests/<requestId>.json                         (Revisor's own copy, never sent back)
//   results/<requestId>/<n>/                          (every result received, kept verbatim)
//   ledger.jsonl
const ID = /^[A-Za-z0-9._-]{1,120}$/;

function safeId(requestId) {
  if (!ID.test(requestId)) throw new Error("request id is not a safe file name.");
  return requestId;
}

export function writeOutbox(exchange, request, inputs, { copy = copyFileSync } = {}) {
  const id = safeId(request.requestId);
  const outbox = join(exchange, "outbox", id);
  if (existsSync(join(exchange, "requests", `${id}.json`))) throw new Error(`request ${id} already exists.`);
  for (const input of inputs) {
    const target = join(outbox, "inputs", ...input.path.split("/"));
    mkdirSync(join(target, ".."), { recursive: true });
    copy(input.absolute, target);
  }
  const text = `${JSON.stringify(request, null, 2)}\n`;
  writeFileSync(join(outbox, "request.json"), text, "utf8");
  mkdirSync(join(exchange, "requests"), { recursive: true });
  writeFileSync(join(exchange, "requests", `${id}.json`), text, "utf8");
  return outbox;
}

// The stored copy is the reference: an executor editing the outbox copy
// cannot change what its result is compared against.
export function loadRequest(exchange, requestId) {
  if (typeof requestId !== "string" || !ID.test(requestId)) return null;
  const path = join(exchange, "requests", `${requestId}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

export function loadAllRequests(exchange) {
  const dir = join(exchange, "requests");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
}

export function readResultDir(resultDir) {
  const raw = JSON.parse(readFileSync(join(resultDir, "result.json"), "utf8"));
  const logName = raw?.log?.file;
  const logPath = typeof logName === "string" && ID.test(logName) ? join(resultDir, logName) : null;
  const logBytes = logPath && existsSync(logPath) ? readFileSync(logPath) : null;
  return { raw, logBytes, logName: logPath ? logName : null };
}

export function archiveResult(exchange, requestId, { raw, logBytes, logName }) {
  const base = join(exchange, "results", ID.test(requestId ?? "") ? requestId : "_unknown");
  mkdirSync(base, { recursive: true });
  const slot = join(base, String(readdirSync(base).length + 1));
  mkdirSync(slot);
  writeFileSync(join(slot, "result.json"), `${JSON.stringify(raw, null, 2)}\n`, "utf8");
  if (logBytes && logName) writeFileSync(join(slot, logName), logBytes);
  return slot;
}
