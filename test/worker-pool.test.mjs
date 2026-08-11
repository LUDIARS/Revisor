import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { PrReviewWorkerPool } from "../src/worker-pool.mjs";

class FakeWorker extends EventEmitter {
  exitCode = null;
  signalCode = null;
  messages = [];

  send(message, callback) {
    this.messages.push(message);
    callback?.(null);
  }

  kill() {
    this.exitCode = 0;
    queueMicrotask(() => this.emit("exit", 0, null));
  }
}

test("dispatches one active job per child worker", async () => {
  const created = [new FakeWorker(), new FakeWorker()];
  const available = [...created];
  const pool = new PrReviewWorkerPool({
    size: 2,
    cwd: process.cwd(),
    createId: (() => {
      let id = 0;
      return () => `task-${++id}`;
    })(),
    forkWorker: () => available.shift(),
  });
  const first = pool.run({ number: 1 });
  const second = pool.run({ number: 2 });
  const third = pool.run({ number: 3 });
  const [workerOne, workerTwo] = created;
  assert.equal(workerOne.messages.length, 1);
  assert.equal(workerTwo.messages.length, 1);
  workerOne.emit("message", {
    type: "result",
    id: workerOne.messages[0].id,
    result: 1,
  });
  assert.equal(await first, 1);
  assert.equal(workerOne.messages.length, 2);
  workerTwo.emit("message", {
    type: "result",
    id: workerTwo.messages[0].id,
    result: 2,
  });
  workerOne.emit("message", {
    type: "result",
    id: workerOne.messages[1].id,
    result: 3,
  });
  assert.deepEqual(await Promise.all([second, third]), [2, 3]);
  await pool.close();
});

test("prioritizes a ready review within its dedicated queue and exposes the queue state", async () => {
  const worker = new FakeWorker();
  const pool = new PrReviewWorkerPool({
    size: 1,
    cwd: process.cwd(),
    createId: (() => {
      let id = 0;
      return () => `priority-${++id}`;
    })(),
    now: (() => {
      let tick = 0;
      return () => `2026-08-08T00:00:0${tick++}.000Z`;
    })(),
    forkWorker: () => worker,
  });
  const current = pool.run({ stage: "reviewer", repository: "LUDIARS/Vultus", number: 10 });
  const routine = pool.run({ stage: "reviewer", repository: "LUDIARS/Vultus", number: 11 });
  const urgent = pool.run(
    { stage: "reviewer", repository: "LUDIARS/Vultus", number: 12 },
    { priority: 0 },
  );

  assert.deepEqual(pool.state().queued.map((entry) => entry.number), [12, 11]);
  assert.equal(pool.state().running[0].number, 10);
  worker.emit("message", {
    type: "result",
    id: worker.messages[0].id,
    result: "current",
  });
  assert.equal(await current, "current");
  assert.equal(worker.messages[1].request.number, 12);
  worker.emit("message", {
    type: "result",
    id: worker.messages[1].id,
    result: "urgent",
  });
  worker.emit("message", {
    type: "result",
    id: worker.messages[2].id,
    result: "routine",
  });
  assert.deepEqual(await Promise.all([routine, urgent]), ["routine", "urgent"]);
  await pool.close();
});

test("standard tasks cannot consume capacity reserved for the fast lane", async () => {
  const created = [new FakeWorker(), new FakeWorker(), new FakeWorker()];
  const available = [...created];
  const pool = new PrReviewWorkerPool({
    size: 3,
    cwd: process.cwd(),
    forkWorker: () => available.shift(),
    fastLaneSlots: 2,
  });
  const normalOne = pool.run({ number: 1 });
  const normalTwo = pool.run({ number: 2 });

  assert.equal(pool.state().workers.fastLaneReserved, 2);
  assert.equal(pool.state().running.length, 1);
  assert.equal(pool.state().queued.length, 1);

  const fastOne = pool.run({ number: 3 }, { reviewLane: "fast" });
  const fastTwo = pool.run({ number: 4 }, { reviewLane: "fast" });
  assert.equal(pool.state().running.length, 3);
  assert.deepEqual(pool.state().running.map((task) => task.reviewLane).sort(), ["fast", "fast", "standard"]);

  for (const worker of created) {
    const message = worker.messages[0];
    worker.emit("message", { type: "result", id: message.id, result: message.request.number });
  }
  // The second normal task starts only after one general-capacity task ends.
  const normalWorker = created.find((worker) => worker.messages.length === 2);
  normalWorker.emit("message", {
    type: "result",
    id: normalWorker.messages[1].id,
    result: normalWorker.messages[1].request.number,
  });
  await Promise.all([normalOne, normalTwo, fastOne, fastTwo]);
  await pool.close();
});

test("fast work stays within its split capacity instead of borrowing standard slots", async () => {
  const created = [new FakeWorker(), new FakeWorker(), new FakeWorker()];
  const available = [...created];
  const pool = new PrReviewWorkerPool({
    size: 3,
    fastLaneSlots: 1,
    cwd: process.cwd(),
    forkWorker: () => available.shift(),
  });
  const first = pool.run({ number: 1 }, { reviewLane: "fast" });
  const second = pool.run({ number: 2 }, { reviewLane: "fast" });
  assert.equal(pool.state().running.length, 1);
  assert.equal(pool.state().queued.length, 1);
  const worker = created.find((candidate) => candidate.messages.length === 1);
  worker.emit("message", { type: "result", id: worker.messages[0].id, result: 1 });
  worker.emit("message", { type: "result", id: worker.messages[1].id, result: 2 });
  await Promise.all([first, second]);
  await pool.close();
});
