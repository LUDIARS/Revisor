import { serviceLog } from "./service-log.mjs";

const DEFAULT_HEARTBEAT_MS = 30_000;
const MAX_TIMER_MS = 2_147_483_647;

// Revisor は 24 時間で 22 回落ちているが、 プロセスログには例外が 1 件も残っていない。
// 「落ちた」 のか 「止められた」 のかを後から言い分けるには、 終わり方そのものを
// 記録するしかない。 この module はその 1 点だけを担う。

// 実測したい値は 2 つ。 RSS が単調増加するのか (memory-leak 警報の裏取り) と、
// event loop が詰まるのか (health probe の失敗がプロセスの死ではなく無応答なのか)。
function measureEventLoopLag(clock, expectedMs, startedAt) {
  return Math.max(0, clock() - startedAt - expectedMs);
}

export function describeServeExit({ signal = null, code = 0 } = {}) {
  if (signal) {
    return `revisor serve: stopping on ${signal} (external stop request)`;
  }
  if (code === 0) return "revisor serve: exiting normally (code=0)";
  return `revisor serve: exiting on its own with code=${code} (not an external stop)`;
}

export function resolveHeartbeatMs(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return DEFAULT_HEARTBEAT_MS;
  }
  const milliseconds = Number(value);
  if (!Number.isInteger(milliseconds) || milliseconds <= 0 || milliseconds > MAX_TIMER_MS) {
    throw new TypeError(
      "REVISOR_HEARTBEAT_MS must be a positive integer within the Node timer range.",
    );
  }
  return milliseconds;
}

export function startRuntimeDiagnostics({
  env = process.env,
  write = serviceLog,
  clock = Date.now,
  setInterval: schedule = setInterval,
  setImmediate: scheduleImmediate = setImmediate,
  clearInterval: unschedule = clearInterval,
  clearImmediate: unscheduleImmediate = clearImmediate,
  memoryUsage = () => process.memoryUsage(),
  // 既定の Node は uncaughtException を握った時点で走り続ける。 これまでどおり
  // 落ちて監督者に再起動させる方が安全なので、 記録した直後に終了する。
  processExit = (code) => process.exit(code),
  on = (event, handler) => process.on(event, handler),
  off = (event, handler) => process.off(event, handler),
  listenerCount = (event) => process.listenerCount(event),
  relaySignal = (signal) => process.kill(process.pid, signal),
  heartbeatMs = env.REVISOR_HEARTBEAT_MS,
  command = null,
} = {}) {
  let intervalMs;
  try {
    intervalMs = resolveHeartbeatMs(heartbeatMs);
  } catch (error) {
    write("service_start_failed", {
      message: error instanceof Error ? error.message : String(error),
    }, { level: "error" });
    throw error;
  }
  write("service_started", {
    nodeVersion: process.version,
    // Do not infer this from process.argv: programmatic CLI callers can leave a
    // test path or another local artifact there. Only admitted service commands
    // are useful operational metadata.
    command: command === "serve" || command === "ui" ? command : null,
    heartbeatMs: intervalMs,
  });

  let heartbeatStartedAt = clock();
  let stopped = false;
  let receivedSignal = null;
  const pendingImmediates = new Set();
  const timer = schedule(() => {
    const previousHeartbeatStartedAt = heartbeatStartedAt;
    heartbeatStartedAt = clock();
    let immediate;
    immediate = scheduleImmediate(() => {
      pendingImmediates.delete(immediate);
      if (stopped) return;
      const memory = memoryUsage();
      write("heartbeat", {
        rssMb: Math.round(memory.rss / 1_048_576),
        heapUsedMb: Math.round(memory.heapUsed / 1_048_576),
        externalMb: Math.round(memory.external / 1_048_576),
        eventLoopLagMs: measureEventLoopLag(clock, intervalMs, previousHeartbeatStartedAt),
        uptimeSec: Math.round(process.uptime()),
      });
    });
    pendingImmediates.add(immediate);
  }, intervalMs);
  timer.unref?.();

  // 監督者による停止 (signal) と、 自分で落ちた場合 (例外) を別の event 名で残す。
  // これまではどちらもログが同じ (何も出ない) だったので、 区別できなかった。
  const handlers = [];
  const observe = (event, handler) => {
    handlers.push([event, handler]);
    on(event, handler);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    const handler = () => {
      receivedSignal = signal;
      write("signal_received", {
        signal,
        reason: describeServeExit({ signal }),
      }, { level: "warn" });
      // Installing a signal listener suppresses Node's default termination. Remove this
      // observer. The original delivery continues to an existing service shutdown hook;
      // during startup, when this is the sole listener, re-deliver for the OS default.
      const hasLifecycleOwner = listenerCount(signal) > 1;
      off(signal, handler);
      if (!hasLifecycleOwner) relaySignal(signal);
    };
    observe(signal, handler);
  }
  observe("uncaughtException", (error) => {
    write("uncaught_exception", {
      message: error?.message ?? String(error),
      stack: error?.stack ?? null,
    }, { level: "error" });
    processExit(1);
  });
  observe("unhandledRejection", (reason) => {
    write("unhandled_rejection", {
      message: reason?.message ?? String(reason),
      stack: reason?.stack ?? null,
    }, { level: "error" });
  });
  observe("exit", (code) => write("process_exit", {
    code,
    reason: describeServeExit({ signal: receivedSignal, code }),
  }));

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      unschedule(timer);
      for (const immediate of pendingImmediates) unscheduleImmediate(immediate);
      pendingImmediates.clear();
      for (const [event, handler] of handlers) off(event, handler);
    },
  };
}
