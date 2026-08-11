import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isLockHeld } from "./file-lock.mjs";
import { workerPresencePath } from "./worker-spawn.mjs";

const EMPTY = Object.freeze({ queues: [] });

/**
 * 審査を実行する短命ワーカーが公開する段階プールの状態ファイル。
 *
 * サーバは審査を実行しないので、 ワーカーのプール状態をメモリでは知り得ない
 * (`server.mjs` 参照)。 その結果 UI の実行状況パネルは常に空を表示していて、
 * 設定した worker 数が効いているかをプロセス一覧でしか確認できなかった。
 * ワーカー側が書き、 サーバ側が読むだけの一方向のファイルで繋ぐ。
 */
export function workerStatePath(jobsPath) {
  return `${jobsPath}.workers.json`;
}

/** ワーカーが状態を書く。 表示のためだけの情報なので、失敗しても審査は続ける。 */
export function writeWorkerState(jobsPath, state) {
  const path = workerStatePath(jobsPath);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ ...state, pid: process.pid }), "utf8");
    renameSync(temporary, path);
  } catch {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // 残骸の掃除に失敗しても、次の書き込みが別名を使うので害はない。
    }
  }
}

/** ワーカーが終了するときに消す。 消せなくても読み手が presence で無効と判断する。 */
export function clearWorkerState(jobsPath) {
  const path = workerStatePath(jobsPath);
  try {
    // A worker releases the presence lock just before its final queue check.
    // A successor can publish its state in that interval, so only remove the
    // state written by this process.
    const state = JSON.parse(readFileSync(path, "utf8"));
    if (state?.pid === process.pid) rmSync(path, { force: true });
  } catch {
    // 消せない状態ファイルは stale として読み手が捨てる。
  }
}

/**
 * サーバが状態を読む。
 *
 * ワーカーは kill されうるので、 ファイルが残っていることは稼働の証拠にならない。
 * 生存判定は presence lock を正本にする — ワーカーが自分の生存期間だけ保持する
 * ロックであり、 状態ファイルの鮮度より確かな一次情報である。
 */
export function readWorkerState(jobsPath) {
  if (!isLockHeld(workerPresencePath(jobsPath))) return EMPTY;
  const path = workerStatePath(jobsPath);
  if (!existsSync(path)) return EMPTY;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(parsed?.queues) ? { queues: parsed.queues } : EMPTY;
  } catch {
    // 書き込み途中を読んだ等。 次のポーリングで拾えるので空を返す。
    return EMPTY;
  }
}
