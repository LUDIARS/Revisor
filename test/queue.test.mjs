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
  const queue = new PrReviewQueue(async () => {
    running += 1;
    maximum = Math.max(maximum, running);
    await new Promise((resolve) => releases.push(resolve));
    running -= 1;
    return { conclusion: "success" };
  }, {
    concurrency: 2,
    createId: (() => {
      let id = 0;
      return () => `job-${++id}`;
    })(),
  });

  const first = queue.submit(request(1));
  assert.equal(queue.submit(request(1)).id, first.id);
  const jobs = [first, queue.submit(request(2)), queue.submit(request(3))];
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(maximum, 2);
  assert.equal(queue.state().queued, 1);
  releases.splice(0).forEach((release) => release());
  await new Promise((resolve) => setImmediate(resolve));
  releases.splice(0).forEach((release) => release());
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(jobs.every((job) => job.status === "completed"));
  assert.equal(maximum, 2);
});
