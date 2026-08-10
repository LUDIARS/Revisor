import assert from "node:assert/strict";
import test from "node:test";
import { PersistentPrReviewQueue } from "../src/persistent-queue.mjs";

test("an existing queued job repairs state left before its jobId was recorded", async () => {
  const reported = [];
  const started = [];
  const job = { id: "job-1", status: "queued", request: { localPrId: "pr-1" } };
  const queue = new PersistentPrReviewQueue({
    jobs: {
      path: "jobs.json",
      async enqueue() { return { job, created: false }; },
    },
    reporter: { async queued(value) { reported.push(value); } },
    startWorker: async (options) => { started.push(options); },
  });
  assert.equal(await queue.submit(job.request), job);
  assert.deepEqual(reported, [job]);
  assert.equal(started.length, 1);
});

test("an existing running job is not projected back to queued", async () => {
  let reported = false;
  const job = { id: "job-1", status: "running", request: { localPrId: "pr-1" } };
  const queue = new PersistentPrReviewQueue({
    jobs: {
      path: "jobs.json",
      async enqueue() { return { job, created: false }; },
    },
    reporter: { async queued() { reported = true; } },
    startWorker: async () => {},
  });
  await queue.submit(job.request);
  assert.equal(reported, false);
});
