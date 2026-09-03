import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { closeSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ensureReviewWorker, workerLogPath } from "../src/worker-spawn.mjs";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "revisor-worker-spawn-"));
  return { directory, jobsPath: join(directory, "revisor.jobs.json") };
}

/** ready を名乗る子のふり。 fork を差し替えて起動オプションだけを観察する。 */
function readyChild(seen) {
  return (options) => {
    seen.push(options);
    const child = new EventEmitter();
    child.pid = 4242;
    child.connected = true;
    child.disconnect = () => { child.connected = false; };
    child.unref = () => {};
    child.off = child.removeListener.bind(child);
    setImmediate(() => child.emit("message", { type: "ready" }));
    return child;
  };
}

// 出力を捨てていたため、 ワーカーが死んでも「died N time(s)」しか残らなかった。
// ログへ向けるのは死因を残すための最低条件なので、 stdio の形そのものを固定する。
test("sends worker output to a log file instead of discarding it", async () => {
  const { directory, jobsPath } = fixture();
  const seen = [];
  try {
    const result = await ensureReviewWorker({ jobsPath, forkWorker: readyChild(seen) });
    assert.equal(result.started, true);
    assert.equal(result.logPath, workerLogPath(jobsPath));
    const [options] = seen;
    assert.equal(options.stdio[0], "ignore");
    assert.equal(typeof options.stdio[1], "number", "stdout must be a file descriptor");
    assert.equal(options.stdio[1], options.stdio[2], "stderr must share the stdout log");
    assert.equal(options.stdio[3], "ipc");
    // 親は fd を子へ渡したら閉じる。 開いたままだと次の起動でログを掴んだ残骸になる。
    // 既に閉じている fd をもう一度閉じると EBADF になることで確かめる。
    assert.throws(() => closeSync(options.stdio[1]), { code: "EBADF" });
  } finally {
    removeFixture(directory);
  }
});

test("keeps the log across restarts and truncates it only when oversized", async () => {
  const { directory, jobsPath } = fixture();
  const logPath = workerLogPath(jobsPath);
  try {
    writeFileSync(logPath, "previous worker output\n");
    await ensureReviewWorker({ jobsPath, forkWorker: readyChild([]) });
    assert.match(readFileSync(logPath, "utf8"), /previous worker output/);

    writeFileSync(logPath, "x".repeat(9 * 1024 * 1024));
    await ensureReviewWorker({ jobsPath, forkWorker: readyChild([]) });
    assert.equal(statSync(logPath).size, 0, "an oversized log is truncated when reopened");
  } finally {
    removeFixture(directory);
  }
});

// ログを開けないこと自体で審査が止まってはいけない。 死因が残らないのは困るが、
// 動かないのはもっと困る。
test("still starts the worker when the log cannot be opened", async () => {
  const { directory, jobsPath } = fixture();
  const seen = [];
  try {
    const unopenable = join(jobsPath, "nested", "revisor.jobs.json");
    const result = await ensureReviewWorker({ jobsPath: unopenable, forkWorker: readyChild(seen) });
    assert.equal(result.started, true);
    assert.equal(result.logPath, null);
    assert.equal(seen[0].stdio[1], "ignore");
  } finally {
    removeFixture(directory);
  }
});
