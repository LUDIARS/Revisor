import assert from "node:assert/strict";
import test from "node:test";
import { PrReviewQueue } from "../src/queue.mjs";

function request(number) {
  return {
    repository: "LUDIARS/Test",
    number,
    headSha: String(number).padStart(40, "0"),
  };
}

test("deduplicates exact heads and caps concurrent reviews", async () => {
  let running = 0;
  let maximum = 0;
  const releases = [];
  const events = [];
  const reporter = {
    async queued(job) {
      job.checkRunId = Number(job.id.replace("job-", ""));
      events.push(`queued:${job.id}`);
    },
    async running(job) {
      events.push(`running:${job.id}`);
    },
    async completed(job) {
      events.push(`completed:${job.id}`);
    },
    async failed(job) {
      events.push(`failed:${job.id}`);
    },
  };
  const queue = new PrReviewQueue(async () => {
    running += 1;
    maximum = Math.max(maximum, running);
    await new Promise((resolve) => releases.push(resolve));
    running -= 1;
    return { conclusion: "success" };
  }, {
    concurrency: 2,
    reporter,
    createId: (() => {
      let id = 0;
      return () => `job-${++id}`;
    })(),
  });

  const [first, duplicate] = await Promise.all([
    queue.submit(request(1)),
    queue.submit(request(1)),
  ]);
  assert.equal(duplicate.id, first.id);
  const jobs = [
    first,
    await queue.submit(request(2)),
    await queue.submit(request(3)),
  ];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maximum, 2);
  assert.equal(queue.state().queued, 1);
  releases.splice(0).forEach((release) => release());
  await new Promise((resolve) => setImmediate(resolve));
  releases.splice(0).forEach((release) => release());
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(jobs.every((job) => job.status === "completed"));
  assert.equal(maximum, 2);
  assert.equal(events.filter((event) => event === "queued:job-1").length, 1);
  assert.equal(events.filter((event) => event.startsWith("completed:")).length, 3);
});

test("a forced submission re-runs a settled head but never doubles an active one", async () => {
  const runs = [];
  const releases = [];
  const reporter = {
    async queued() {},
    async running() {},
    async completed() {},
    async failed() {},
  };
  const queue = new PrReviewQueue(async (submission) => {
    runs.push(submission.headSha);
    await new Promise((resolve) => releases.push(resolve));
    return { conclusion: "success" };
  }, { concurrency: 1, reporter });

  const first = await queue.submit(request(1));
  await new Promise((resolve) => setImmediate(resolve));
  const whileRunning = await queue.submit(request(1), { force: true });
  assert.equal(whileRunning.id, first.id);
  assert.equal(runs.length, 1);

  releases.splice(0).forEach((release) => release());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(first.status, "completed");
  assert.equal((await queue.submit(request(1))).id, first.id);
  assert.equal(runs.length, 1);

  const forced = await queue.submit(request(1), { force: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.notEqual(forced.id, first.id);
  assert.equal(runs.length, 2);
  releases.splice(0).forEach((release) => release());
});

test("passes the active job identity to the runner", async () => {
  let received;
  const queue = new PrReviewQueue(async (submission) => {
    received = submission;
    return { conclusion: "success" };
  }, {
    reporter: {
      async queued() {},
      async running() {},
      async completed() {},
      async failed() {},
    },
    createId: () => "job-identity",
  });

  await queue.submit(request(1));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(received.jobId, "job-identity");
});
