import assert from "node:assert/strict";
import test from "node:test";
import { drainReviewJobs } from "../src/review-job-scheduler.mjs";

test("rejects a reservation larger than two slots", async () => {
  await assert.rejects(() => drainReviewJobs({
    jobs: { state: () => ({ jobs: [] }), claimNext: async () => null },
    concurrency: 4,
    reservation: 3,
    run: async () => {},
  }), /1 or 2/);
});

test("holds persisted fast jobs when no fast-lane slot is configured", async () => {
  const queued = [{ id: "fast-legacy", status: "queued", reviewLane: "fast" }];
  let claimed = false;
  const result = await drainReviewJobs({
    jobs: {
      state: () => ({ jobs: queued }),
      claimNext: async () => { claimed = true; return queued.shift() ?? null; },
    },
    concurrency: 1,
    reservation: 0,
    run: async () => {},
  });
  assert.deepEqual(result, { ran: 0, heldFast: 1 });
  assert.equal(claimed, false);
});

test("a fast job arriving during standard work enters the reserved orchestration slot", async () => {
  const queued = [{ id: "standard-1", status: "queued", reviewLane: "standard" }];
  const started = [];
  let finishNormal;
  const normalDone = new Promise((resolve) => { finishNormal = resolve; });
  let finishFast;
  const fastDone = new Promise((resolve) => { finishFast = resolve; });
  const jobs = {
    state: () => ({ jobs: queued.map((job) => ({ ...job })) }),
    async claimNext({ reviewLane }) {
      const index = queued.findIndex((job) => job.status === "queued" && job.reviewLane === reviewLane);
      if (index < 0) return null;
      const [job] = queued.splice(index, 1);
      return job;
    },
  };
  const draining = drainReviewJobs({
    jobs,
    concurrency: 2,
    reservation: 1,
    queueCheckIntervalMs: 1,
    run: async (job) => {
      started.push(job.id);
      await (job.reviewLane === "fast" ? fastDone : normalDone);
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  queued.push({ id: "fast-1", status: "queued", reviewLane: "fast" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(started, ["standard-1", "fast-1"]);
  finishFast();
  finishNormal();
  assert.deepEqual(await draining, { ran: 2 });
});

// 旧 in-process キューが持っていた同時実行の上限は、いまは drain 側の責務になっている。
test("never runs more reviews at once than the configured concurrency", async () => {
  const queued = ["job-1", "job-2", "job-3"].map((id) =>
    ({ id, status: "queued", reviewLane: "standard" }));
  let running = 0;
  let maximum = 0;
  const releases = [];
  const jobs = {
    state: () => ({ jobs: queued.map((job) => ({ ...job })) }),
    async claimNext({ reviewLane }) {
      const index = queued.findIndex((job) =>
        job.status === "queued" && job.reviewLane === reviewLane);
      if (index < 0) return null;
      const [job] = queued.splice(index, 1);
      return job;
    },
  };
  const draining = drainReviewJobs({
    jobs,
    concurrency: 2,
    reservation: 0,
    queueCheckIntervalMs: 1,
    run: async () => {
      running += 1;
      maximum = Math.max(maximum, running);
      await new Promise((resolve) => releases.push(resolve));
      running -= 1;
    },
  });
  while (releases.length < 2) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(maximum, 2);
  assert.equal(queued.length, 1, "the third job waits for a free slot");
  releases.splice(0).forEach((release) => release());
  while (releases.length < 1) await new Promise((resolve) => setTimeout(resolve, 1));
  releases.splice(0).forEach((release) => release());
  assert.deepEqual(await draining, { ran: 3 });
  assert.equal(maximum, 2);
});
