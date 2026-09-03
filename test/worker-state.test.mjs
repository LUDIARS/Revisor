import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { tryAcquireLock } from "../src/file-lock.mjs";
import { workerPresencePath } from "../src/worker-spawn.mjs";
import {
  clearWorkerState,
  readWorkerState,
  workerStatePath,
  writeWorkerState,
} from "../src/worker-state.mjs";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "revisor-worker-state-"));
  return { directory, jobsPath: join(directory, "revisor.jobs.json") };
}

const STATE = {
  queues: [
    { id: "tests", label: "登録テスト", workers: { configured: 3, idle: 2, running: 1 } },
  ],
};

test("the server reads the state the worker published", () => {
  const { directory, jobsPath } = fixture();
  const release = tryAcquireLock(workerPresencePath(jobsPath), { label: "review-worker" });
  try {
    writeWorkerState(jobsPath, STATE);
    assert.deepEqual(readWorkerState(jobsPath), STATE);
  } finally {
    release?.();
    removeFixture(directory);
  }
});

// ワーカーは kill されうるので、状態ファイルが残っていることは稼働の証拠にならない。
// 生存判定は presence lock を正本にする。 これが無いと、 停止したワーカーの最後の
// 状態が「いま 3 本動いている」として UI に出続ける。
test("a state file left behind by a dead worker is not reported as live", () => {
  const { directory, jobsPath } = fixture();
  try {
    const release = tryAcquireLock(workerPresencePath(jobsPath), { label: "review-worker" });
    writeWorkerState(jobsPath, STATE);
    release?.();
    assert.deepEqual(readWorkerState(jobsPath), { queues: [] });
  } finally {
    removeFixture(directory);
  }
});

test("a partially written state file reports empty instead of throwing", () => {
  const { directory, jobsPath } = fixture();
  const release = tryAcquireLock(workerPresencePath(jobsPath), { label: "review-worker" });
  try {
    writeFileSync(workerStatePath(jobsPath), '{"queues":[', "utf8");
    assert.deepEqual(readWorkerState(jobsPath), { queues: [] });
  } finally {
    release?.();
    removeFixture(directory);
  }
});

test("clearing removes the published state", () => {
  const { directory, jobsPath } = fixture();
  const release = tryAcquireLock(workerPresencePath(jobsPath), { label: "review-worker" });
  try {
    writeWorkerState(jobsPath, STATE);
    clearWorkerState(jobsPath);
    assert.deepEqual(readWorkerState(jobsPath), { queues: [] });
  } finally {
    release?.();
    removeFixture(directory);
  }
});

test("an exiting worker does not clear a successor's state", () => {
  const { directory, jobsPath } = fixture();
  const release = tryAcquireLock(workerPresencePath(jobsPath), { label: "review-worker" });
  try {
    writeFileSync(
      workerStatePath(jobsPath),
      JSON.stringify({ ...STATE, pid: process.pid + 1 }),
      "utf8",
    );
    clearWorkerState(jobsPath);
    assert.deepEqual(readWorkerState(jobsPath), STATE);
  } finally {
    release?.();
    removeFixture(directory);
  }
});
