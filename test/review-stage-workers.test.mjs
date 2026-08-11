import assert from "node:assert/strict";
import test from "node:test";
import { ReviewStageWorkers } from "../src/review-stage-workers.mjs";
import { REVIEW_WORK_STAGES } from "../src/review-work.mjs";

class FakePool {
  constructor(options) {
    this.options = options;
    this.work = [];
    this.closed = false;
  }

  run(work, options) {
    this.work.push({ work, options });
    this.options.onStateChange();
    return Promise.resolve(work.stage);
  }

  state() {
    return {
      workers: { configured: this.options.size, idle: this.options.size, running: 0 },
      queued: [],
      running: [],
    };
  }

  async close() {
    this.closed = true;
  }
}

test("routes each review concern to its own dedicated pool", async () => {
  const pools = [];
  const states = [];
  const workers = new ReviewStageWorkers({
    size: 2,
    fastLaneSlots: 1,
    cwd: process.cwd(),
    createPool: (options) => {
      const pool = new FakePool(options);
      pools.push(pool);
      return pool;
    },
    onStateChange: (state) => states.push(state),
  });
  const stages = [
    REVIEW_WORK_STAGES.ANALYZE,
    REVIEW_WORK_STAGES.TEST,
    REVIEW_WORK_STAGES.REVIEW,
    REVIEW_WORK_STAGES.SECURITY,
  ];
  await Promise.all(stages.map((stage, index) => workers.run(
    { stage, number: index + 1 },
    { priority: index, reviewLane: index === 0 ? "fast" : "standard" },
  )));

  assert.equal(pools.length, 4);
  assert.deepEqual(pools.map((pool) => pool.work[0]?.work.stage), stages);
  assert.deepEqual(pools.map((pool) => pool.work[0]?.options.priority), [0, 1, 2, 3]);
  assert.deepEqual(pools.map((pool) => pool.options.fastLaneSlots), [1, 1, 1, 1]);
  assert.deepEqual(pools.map((pool) => pool.work[0]?.options.reviewLane), [
    "fast", "standard", "standard", "standard",
  ]);
  assert.deepEqual(workers.state().queues.map((queue) => queue.id), [
    "anatomia", "tests", "review", "security",
  ]);
  assert.equal(states.length, 4);
  await assert.rejects(workers.run({ stage: "not-a-stage" }), /Unsupported review work stage/);
  await workers.close();
  assert.ok(pools.every((pool) => pool.closed));
});
