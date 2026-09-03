import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runReviewWorker } from "../src/worker-command.mjs";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

test("a job submitted during the final sweep is drained without another wake", async () => {
  const directory = mkdtempSync(join(tmpdir(), "revisor-worker-exit-"));
  const queued = [];
  const completed = [];
  const settled = [];
  let sweepCount = 0;
  let readyCount = 0;
  let closed = false;
  let runnerOptions;
  const reconciled = [];
  const job = {
    id: "job-late",
    status: "queued",
    reviewLane: "standard",
    request: { localPrId: "pr-1", headSha: "a".repeat(40), reviewLane: "standard" },
  };
  const context = {
    settings: { workerCount: 1, fastLaneSlots: 0 },
    jobs: {
      path: join(directory, "jobs.json"),
      async reclaimAbandoned() { return { requeued: [], exhausted: [] }; },
      async claimNext({ reviewLane }) {
        const index = queued.findIndex((entry) => entry.reviewLane === reviewLane);
        return index < 0 ? null : queued.splice(index, 1)[0];
      },
      async settle(id, outcome) { settled.push({ id, ...outcome }); },
      state() { return { queued: queued.length, jobs: queued.map((entry) => ({ ...entry })) }; },
    },
    reporter: {
      async running() {},
      async completed(entry) { completed.push(entry); },
      async failed() {},
      async narrativeReconciled(id, narrative) { reconciled.push({ id, ...narrative }); },
    },
    localPrService: {
      async recoverInterruptedReviews() {
        return { scanned: 0, recovered: [], failed: [] };
      },
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
        state() { return { queues: [] }; },
        async run(work) { return work(); },
        async close() { closed = true; },
      }),
      createRunner: (options) => {
        runnerOptions = options;
        return async () => ({ conclusion: "success" });
      },
      signalReady: () => { readyCount += 1; },
    });
    assert.deepEqual(outcome, { ran: 1, skipped: false });
    assert.equal(readyCount, 1);
    assert.equal(sweepCount, 2);
    assert.equal(closed, true);
    assert.equal(completed.length, 1);
    assert.deepEqual(settled, [{ id: "job-late", status: "completed" }]);
    await runnerOptions.onNarrativeReconciled({
      localPrId: "pr-1",
      headSha: job.request.headSha,
      title: null,
      body: "本文\n\n## 解説\n説明",
    });
    assert.deepEqual(reconciled, [{
      id: "pr-1",
      headSha: job.request.headSha,
      title: null,
      body: "本文\n\n## 解説\n説明",
    }]);
  } finally {
    removeFixture(directory);
  }
});

test("recovers interrupted local PR reviews when the worker starts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "revisor-worker-recovery-"));
  const messages = [];
  let recoveries = 0;
  const context = {
    settings: { workerCount: 1, fastLaneSlots: 0 },
    jobs: {
      path: join(directory, "jobs.json"),
      async reclaimAbandoned() { return { requeued: [], exhausted: [] }; },
      async claimNext() { return null; },
      state() { return { queued: 0, jobs: [] }; },
    },
    reporter: { async failed() {} },
    localPrService: {
      async recoverInterruptedReviews() {
        recoveries += 1;
        return { scanned: 2, recovered: [{ id: "pr-1" }], failed: [{ id: "pr-2" }] };
      },
      async sweepAutoMerge() { return { attempted: 0, merged: 0, failed: 0 }; },
    },
  };
  try {
    await runReviewWorker({
      createContext: () => context,
      createStageWorkers: () => ({ state() { return { queues: [] }; }, async close() {} }),
      createRunner: () => async () => ({}),
      log: (message) => messages.push(message),
    });
    assert.equal(recoveries, 1);
    assert.ok(messages.includes("Revisor worker recovered interrupted reviews: recovered=1 failed=1"));
  } finally {
    removeFixture(directory);
  }
});
