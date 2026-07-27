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
