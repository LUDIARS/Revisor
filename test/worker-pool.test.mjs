import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { PrReviewWorkerPool } from "../src/worker-pool.mjs";

class FakeWorker extends EventEmitter {
  exitCode = null;
  signalCode = null;
  messages = [];
  pid = 12_345;

  send(message, callback) {
    this.messages.push(message);
    callback?.(null);
  }

  kill() {
    this.exitCode = 0;
    queueMicrotask(() => this.emit("exit", 0, null));
  }
}

/** まだ結果を返していない配布分。 どのワーカーへ配られたかは決め打ちしない。 */
function pendingDispatches(workers, settled) {
  return workers.flatMap((worker) => worker.messages
    .filter((message) => !settled.has(message.id))
    .map((message) => ({ worker, message })));
}

function settle({ worker, message }, settled, result) {
  settled.add(message.id);
  worker.emit("message", { type: "result", id: message.id, result });
}

// fast lane の予約枠は、 fast の待ちが無くても standard へ貸さない (既存仕様。
// 4 本目のテスト "standard tasks cannot consume capacity reserved for the fast lane"
// と同じ扱い)。 size 2 で予約 1 なら standard の同時実行は 1 本になる。
test("runs one standard job at a time while a slot stays reserved for the fast lane", async () => {
  const created = [new FakeWorker(), new FakeWorker()];
  const available = [...created];
  const events = [];
  const pool = new PrReviewWorkerPool({
    size: 2,
    cwd: process.cwd(),
    createId: (() => {
      let id = 0;
      return () => `task-${++id}`;
    })(),
    log: (event, detail) => events.push([event, detail]),
    forkWorker: () => available.shift(),
  });
  const settled = new Set();
  assert.deepEqual(events.map(([event]) => event), [
    "review_worker_spawned",
    "review_worker_spawned",
  ]);
  assert.equal(events[0][1].workerPid, 12_345);
  const first = pool.run({ number: 1 });
  const second = pool.run({ number: 2 });
  const third = pool.run({ number: 3 });

  assert.equal(pool.state().workers.fastLaneReserved, 1);
  assert.equal(pool.state().running.length, 1);
  assert.equal(pool.state().queued.length, 2);
  assert.equal(pendingDispatches(created, settled).length, 1);

  settle(pendingDispatches(created, settled)[0], settled, 1);
  assert.equal(await first, 1);

  // 1 本終わって初めて次が出る。 配布先のワーカーは固定しない。
  const secondDispatch = pendingDispatches(created, settled);
  assert.equal(secondDispatch.length, 1);
  settle(secondDispatch[0], settled, 2);
  assert.equal(await second, 2);

  const thirdDispatch = pendingDispatches(created, settled);
  assert.equal(thirdDispatch.length, 1);
  settle(thirdDispatch[0], settled, 3);
  assert.equal(await third, 3);
  await pool.close();
  assert.deepEqual(events.slice(2).map(([event]) => event), [
    "review_worker_exited",
    "review_worker_exited",
  ]);
  assert.equal(events[2][1].closing, true);
  assert.equal(events[2][1].workerPid, 12_345);
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
  const settled = new Set();
  const first = pool.run({ number: 1 }, { reviewLane: "fast" });
  const second = pool.run({ number: 2 }, { reviewLane: "fast" });
  assert.equal(pool.state().running.length, 1);
  assert.equal(pool.state().queued.length, 1);

  settle(pendingDispatches(created, settled)[0], settled, 1);
  assert.equal(await first, 1);

  // 2 本目は 1 本目が終わってから配られる。 同じワーカーとは限らないので、
  // 実際に配られた先から読む (messages[1] の決め打ちが TypeError の原因だった)。
  const secondDispatch = pendingDispatches(created, settled);
  assert.equal(secondDispatch.length, 1);
  settle(secondDispatch[0], settled, 2);
  assert.equal(await second, 2);
  await pool.close();
});
