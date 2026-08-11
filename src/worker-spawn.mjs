import { fork } from "node:child_process";
import { closeSync, fchmodSync, openSync, statSync, truncateSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isLockHeld } from "./file-lock.mjs";

const CLI_PATH = fileURLToPath(new URL("./cli.mjs", import.meta.url));

/** ワーカーログを開き直すときに切り詰める上限。 */
const WORKER_LOG_MAX_BYTES = 8 * 1024 * 1024;

// ワーカーの多重起動防止に使う presence lock のパス。 job ファイルとは別名にして、
// キューの mutate lock と衝突させない。
export function workerPresencePath(jobsPath) {
  return `${jobsPath}.worker`;
}

/**
 * ワーカーの stdout/stderr を落とす先。
 *
 * ここが無かった間、 ワーカーは `stdio: ["ignore", "ignore", "ignore", "ipc"]` で
 * 起動していたため、 死んでも出力がどこにも残らなかった。 job には
 * 「The review worker died N time(s)」しか記録されず、 死因を追う手掛かりが
 * 存在しない状態だった (2026-08-11、 無関係な 2 本の PR が同じ文言で落ちた)。
 */
export function workerLogPath(jobsPath) {
  return `${jobsPath}.worker.log`;
}

/**
 * ワーカーログを追記モードで開く。 肥大した場合は開くときだけ切り詰める
 * (稼働中の rename は Windows で失敗するため)。 開けない場合は null を返し、
 * ログが取れないことを理由に起動そのものを止めない。
 */
function openWorkerLog(jobsPath) {
  const path = workerLogPath(jobsPath);
  let fd = null;
  try {
    const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0;
    if (size > WORKER_LOG_MAX_BYTES) truncateSync(path, 0);
    fd = openSync(path, "a", 0o600);
    // Worker output can contain checkout paths and diagnostics from invoked
    // tools, so keep the local diagnostic log private like the state files.
    fchmodSync(fd, 0o600);
    return fd;
  } catch {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // The descriptor may already have been closed after a failed permission update.
      }
    }
    return null;
  }
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
  // 出力はファイル fd へ直接向ける。 親が pipe で受けると、 親 (serve) が先に
  // 終わったときに子が EPIPE で死ぬ。 fd は子へ渡ったら親側では閉じる — 開いたまま
  // 抱えると、 次の起動でログを掴んだままの残骸になる。
  const logFd = openWorkerLog(jobsPath);
  let child;
  try {
    child = forkWorker({
      cwd,
      env,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd ?? "ignore", logFd ?? "ignore", "ipc"],
    });
  } finally {
    if (logFd !== null) closeSync(logFd);
  }
  await waitForReady(child, readyTimeoutMs);
  child.disconnect();
  child.unref();
  return { started: true, pid: child.pid, logPath: logFd === null ? null : workerLogPath(jobsPath) };
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
