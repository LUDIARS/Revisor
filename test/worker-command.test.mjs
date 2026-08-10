import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runReviewWorker } from "../src/worker-command.mjs";

test("a job submitted during the final sweep is drained without another wake", async () => {
  const directory = mkdtempSync(join(tmpdir(), "revisor-worker-exit-"));
  const queued = [];
  const completed = [];
  const settled = [];
  let sweepCount = 0;
  let readyCount = 0;
  let closed = false;
  const job = {
    id: "job-late",
    request: { localPrId: "pr-1", headSha: "a".repeat(40) },
  };
  const context = {
    settings: { workerCount: 1 },
    jobs: {
      path: join(directory, "jobs.json"),
      async reclaimAbandoned() { return { requeued: [], exhausted: [] }; },
      async claimNext() { return queued.shift() ?? null; },
      async settle(id, outcome) { settled.push({ id, ...outcome }); },
      state() { return { queued: queued.length }; },
    },
    reporter: {
      async running() {},
      async completed(entry) { completed.push(entry); },
      async failed() {},
    },
    localPrService: {
      async sweepAutoMerge() {
        sweepCount += 1;
        if (sweepCount === 1) queued.push(job);
        return { attempted: 0, merged: 0, failed: 0 };
      },
    },
  };
  try {
    const outcome = await runReviewWorker({
      createContext: () => context,
      createStageWorkers: () => ({
        async run(work) { return work(); },
        async close() { closed = true; },
      }),
      createRunner: () => async () => ({ conclusion: "success" }),
      signalReady: () => { readyCount += 1; },
    });
    assert.deepEqual(outcome, { ran: 1, skipped: false });
    assert.equal(readyCount, 1);
    assert.equal(sweepCount, 2);
    assert.equal(closed, true);
    assert.equal(completed.length, 1);
    assert.deepEqual(settled, [{ id: "job-late", status: "completed" }]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
