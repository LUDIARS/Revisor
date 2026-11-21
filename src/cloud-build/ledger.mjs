import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ACCEPTED = new Set(["passed", "failed", "not_executed"]);

export function ledgerPath(exchange) {
  return join(exchange, "ledger.jsonl");
}

// Append-only: a rejected or conflicting result never rewrites what an
// earlier accepted result recorded.
export function readLedger(exchange) {
  const path = ledgerPath(exchange);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim()).map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`ledger line ${index + 1} is not valid JSON.`);
    }
  });
}

export function appendLedger(exchange, record) {
  const path = ledgerPath(exchange);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

/**
 * Summarises one run at one head.  Only accepted records count; a shard with
 * nothing accepted is `missing`, so an unexecuted or lost shard can never make
 * the run look complete.
 */
export function summarizeRun(records, requests, { runId, headSha }) {
  const shards = requests.filter((request) => request.runId === runId && request.headSha === headSha);
  if (shards.length === 0) return { runId, headSha, state: "unknown", shards: [] };
  const rows = shards
    .sort((left, right) => left.shard.index - right.shard.index)
    .map((request) => {
      const accepted = records.find((record) => record.requestId === request.requestId && ACCEPTED.has(record.classification));
      return { shardId: request.shardId, requestId: request.requestId, outcome: accepted ? accepted.classification : "missing" };
    });
  const expected = shards[0].shard.count;
  const outcomes = rows.map((row) => row.outcome);
  let state = "complete";
  if (outcomes.includes("failed")) state = "failed";
  else if (rows.length < expected || outcomes.some((outcome) => outcome !== "passed")) state = "partial";
  return { runId, headSha, state, expectedShards: expected, shards: rows };
}
