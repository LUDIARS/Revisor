import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

// プロセス間の相互排他。 常駐バックエンドを廃したことで、 state の read-modify-write と
// base ref を進める publication は「同時に走る別プロセス」から守る必要がある。
// ディレクトリ作成の原子性だけに頼る (O_EXCL 相当が全 OS で効く唯一の手段)。

// owner.json がまだ書かれていない取得直後や、壊れた owner を即座に消さないための猶予。
// 正常な owner は pid の生存だけで判定し、長時間の審査を時刻だけで stale にしない。
const INCOMPLETE_LOCK_STALE_MS = 120_000;
const POLL_MS = 25;
const syncSleepBuffer = new Int32Array(new SharedArrayBuffer(4));

function lockDirectory(path) {
  return `${path}.lock`;
}

// 保持者が死んでいるロックは奪う。 ロックを持ったまま kill されたワーカーが
// 以後の全コマンドを永久に止めるのを防ぐ。 生存判定は signal 0。
function readOwner(directory) {
  try {
    return JSON.parse(readFileSync(join(directory, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

function processIsGone(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM は「居るが権限が無い」なので生存扱い。 ESRCH だけが不在の証拠。
    return error.code === "ESRCH" ? true : false;
  }
}

function lockCanBeReclaimed(directory, now) {
  const owner = readOwner(directory);
  const gone = processIsGone(owner?.pid);
  if (gone !== null) return gone;

  // owner を書く直前の取得者や、一時的な部分読みを stale と誤認しない。
  // pid を判定できない壊れたロックだけを、十分な猶予の後に掃除する。
  let observedAt = Number.isFinite(owner?.at) ? owner.at : null;
  try {
    observedAt ??= statSync(directory).mtimeMs;
  } catch {
    return false;
  }
  return now - observedAt > INCOMPLETE_LOCK_STALE_MS;
}

function reclaimLock(directory, now) {
  // stale 判定後の削除を直列化する。複数プロセスが同じ stale directory を消しに来て、
  // 一方が作り直した新しい lock を他方が削除する競合を防ぐ。
  // reclaimer 自体も所有者付き lock にして、掃除中に死んでも永久に残らないようにする。
  const releaseReclaimer = tryAcquireLock(`${directory}.reclaimer`, {
    label: "lock-reclaimer",
    now: () => now,
  });
  if (!releaseReclaimer) return;
  try {
    if (existsSync(directory) && lockCanBeReclaimed(directory, now)) {
      rmSync(directory, { recursive: true, force: true });
    }
  } finally {
    releaseReclaimer();
  }
}

function acquireOnce(directory, label, now) {
  const token = randomUUID();
  try {
    mkdirSync(directory);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!lockCanBeReclaimed(directory, now)) return null;
    // 死んだ保持者 / 期限切れのロックを畳んでから、次の周回で正規に取り直す。
    // ここで直接「自分のもの」にすると、同時に奪いに来た別プロセスと二重取得になる。
    reclaimLock(directory, now);
    return null;
  }
  try {
    writeFileSync(
      join(directory, "owner.json"),
      JSON.stringify({ pid: process.pid, token, label, at: now }),
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
  } catch (error) {
    // owner を作れなかった directory を残すと、全利用者が猶予切れまで待たされる。
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return token;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sleepSync = (ms) => Atomics.wait(syncSleepBuffer, 0, 0, ms);

function releaseLock(directory, token) {
  // 古い保持者の finally が、既に奪取・再取得された別所有者の lock を消さないようにする。
  if (readOwner(directory)?.token !== token) return;
  rmSync(directory, { recursive: true, force: true });
}

/**
 * 生きている保持者が居るかだけを見る。 奪いも掃除もしない。
 *
 * 「ワーカーが既に居るなら起動しない」の判定はこちら。 判定のために一度ロックを
 * 取ってしまうと、起動した子が自分の presence を取れずに死ぬ。
 *
 * @implements SPEC-DAEMONLESS-PROCESS-LOCKS
 */
export function isLockHeld(path) {
  const directory = lockDirectory(path);
  if (!existsSync(directory)) return false;
  return !lockCanBeReclaimed(directory, Date.now());
}

/**
 * 取れたら解放関数、取れなければ null。 待たない。
 *
 * ワーカーの多重起動防止のように「保持したまま長く走り、取れなければ何もしない」
 * 用途はこちら。 スコープが 1 つの関数に収まらないので `withFileLock` に載せられない。
 *
 * @implements SPEC-DAEMONLESS-PROCESS-LOCKS
 */
export function tryAcquireLock(path, { label = "revisor", now = () => Date.now() } = {}) {
  const directory = lockDirectory(path);
  mkdirSync(dirname(directory), { recursive: true });
  // 1 回目が死んだ保持者の掃除で終わることがあるので、掃除後の取得までを 1 度だけ再試行する。
  const token = acquireOnce(directory, label, now()) ?? acquireOnce(directory, label, now());
  if (!token) return null;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseLock(directory, token);
  };
}

/**
 * 同期 API の read-modify-write をプロセス間で直列化する。
 *
 * @implements SPEC-DAEMONLESS-PROCESS-LOCKS
 */
export function withFileLockSync(path, run, {
  label = "revisor",
  timeoutMs = 60_000,
  now = () => Date.now(),
} = {}) {
  const directory = lockDirectory(path);
  mkdirSync(dirname(directory), { recursive: true });
  const deadline = now() + timeoutMs;
  let token;
  while (!(token = acquireOnce(directory, label, now()))) {
    if (now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for the Revisor lock at ${directory}.`);
    }
    sleepSync(POLL_MS);
  }
  try {
    return run();
  } finally {
    releaseLock(directory, token);
  }
}

/**
 * `path` に紐づくロックを取り、`run` を実行して必ず解放する。
 *
 * 待ちは有限。 待ち切れなかったら失敗させる — 無期限に待つと、詰まった 1 プロセスが
 * すべてのコマンドを黙って積み上げる (常駐を捨てた意味が無くなる)。
 *
 * @implements SPEC-DAEMONLESS-PROCESS-LOCKS
 */
export async function withFileLock(path, run, {
  label = "revisor",
  timeoutMs = 60_000,
  now = () => Date.now(),
} = {}) {
  const directory = lockDirectory(path);
  mkdirSync(dirname(directory), { recursive: true });
  const deadline = now() + timeoutMs;
  let token;
  while (!(token = acquireOnce(directory, label, now()))) {
    if (now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for the Revisor lock at ${directory}.`);
    }
    await sleep(POLL_MS);
  }
  try {
    return await run();
  } finally {
    releaseLock(directory, token);
  }
}
