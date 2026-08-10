import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isLockHeld } from "./file-lock.mjs";

const CLI_PATH = fileURLToPath(new URL("./cli.mjs", import.meta.url));

// ワーカーの多重起動防止に使う presence lock のパス。 job ファイルとは別名にして、
// キューの mutate lock と衝突させない。
export function workerPresencePath(jobsPath) {
  return `${jobsPath}.worker`;
}

/**
 * 短命ワーカーが 1 つも走っていなければ起動する。
 *
 * ワーカーはキューが空になるまで回して終わるので、常に 1 本で足りる。 走っている
 * 間に投入された job も同じワーカーが拾うため、投入のたびに増やす必要はない。
 *
 * 起動は「起きたことを子が名乗るまで待つ」。 spawn イベントは起動完了ではなく、
 * 親が即座に終了すると Windows では子ごと消えるため、ready を受けてから手放す。
 */
export async function ensureReviewWorker({
  jobsPath,
  cwd = process.cwd(),
  env = process.env,
  forkWorker = (options) => fork(CLI_PATH, ["run-worker"], options),
  readyTimeoutMs = 15_000,
} = {}) {
  // presence は起動したワーカー自身が自分の生存期間だけ保持する。 ここで取ってしまうと、
  // 起動した子が自分の presence を取れない。 判定は「生きている保持者が居るか」だけ。
  // 取りこぼして 2 本起動しても、claim は排他なので同じ job は二重実行されない。
  if (isLockHeld(workerPresencePath(jobsPath))) {
    return { started: false, reason: "a review worker is already running" };
  }
  const child = forkWorker({
    cwd,
    env,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  await waitForReady(child, readyTimeoutMs);
  child.disconnect();
  child.unref();
  return { started: true, pid: child.pid };
}

function waitForReady(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      child.kill();
      if (child.connected) child.disconnect();
      child.unref();
      reject(new Error("The review worker did not report readiness in time."));
    }, timeoutMs);
    const onMessage = (message) => {
      if (!message || message.type !== "ready") return;
      cleanup();
      resolve();
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`The review worker exited before starting (${signal ?? code ?? "unknown"}).`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}
