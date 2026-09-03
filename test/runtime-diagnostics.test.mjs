import assert from "node:assert/strict";
import test from "node:test";
import { resolveHeartbeatMs, startRuntimeDiagnostics } from "../src/runtime-diagnostics.mjs";

test("separates a supervisor stop from a crash and exits on an uncaught error", () => {
  const events = [];
  const handlers = new Map();
  const exits = [];
  const relayedSignals = [];
  let timerCleared = false;
  const diagnostics = startRuntimeDiagnostics({
    env: {},
    command: "serve",
    write: (event, detail) => events.push([event, detail]),
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {
      timerCleared = true;
    },
    on: (event, handler) => handlers.set(event, handler),
    off: (event, handler) => {
      if (handlers.get(event) === handler) handlers.delete(event);
    },
    listenerCount: (event) => handlers.has(event) ? 1 : 0,
    relaySignal: (signal) => relayedSignals.push(signal),
    processExit: (code) => exits.push(code),
  });

  assert.equal(events[0][0], "service_started");
  assert.equal(events[0][1].command, "serve");
  handlers.get("SIGTERM")();
  handlers.get("uncaughtException")(new Error("boom"));
  handlers.get("exit")(1);

  assert.deepEqual(events.slice(1).map(([event]) => event), [
    "signal_received",
    "uncaught_exception",
    "process_exit",
  ]);
  assert.equal(events[1][1].signal, "SIGTERM");
  assert.equal(
    events[1][1].reason,
    "revisor serve: stopping on SIGTERM (external stop request)",
  );
  assert.match(events[2][1].stack, /boom/);
  assert.equal(
    events[3][1].reason,
    "revisor serve: stopping on SIGTERM (external stop request)",
  );
  assert.deepEqual(exits, [1]);
  assert.deepEqual(relayedSignals, ["SIGTERM"]);

  diagnostics.stop();
  assert.equal(timerCleared, true);
  assert.equal(handlers.size, 0);
});

test("lets an installed service shutdown hook own the original signal", () => {
  const handlers = new Map();
  const relayedSignals = [];
  startRuntimeDiagnostics({
    env: {},
    write: () => {},
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    on: (event, handler) => handlers.set(event, handler),
    off: () => {},
    listenerCount: () => 2,
    relaySignal: (signal) => relayedSignals.push(signal),
  });

  handlers.get("SIGTERM")();
  assert.deepEqual(relayedSignals, []);
});

test("classifies an exit without a preceding signal from its code", () => {
  const events = [];
  const handlers = new Map();
  startRuntimeDiagnostics({
    env: {},
    write: (event, detail) => events.push([event, detail]),
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    on: (event, handler) => handlers.set(event, handler),
    off: () => {},
  });

  handlers.get("exit")(1);

  assert.equal(events.at(-1)[0], "process_exit");
  assert.equal(
    events.at(-1)[1].reason,
    "revisor serve: exiting on its own with code=1 (not an external stop)",
  );
});

test("reports memory and event loop lag on every heartbeat", () => {
  const events = [];
  let beat;
  let immediate;
  let now = 0;
  startRuntimeDiagnostics({
    env: {},
    write: (event, detail) => events.push([event, detail]),
    clock: () => now,
    heartbeatMs: 30_000,
    setInterval: (callback) => {
      beat = callback;
      return { unref() {} };
    },
    setImmediate: (callback) => {
      immediate = callback;
    },
    clearInterval: () => {},
    on: () => {},
    off: () => {},
    memoryUsage: () => ({ rss: 815 * 1_048_576, heapUsed: 100 * 1_048_576, external: 0 }),
  });

  now = 45_000;
  beat();
  now = 50_000;
  immediate();

  const heartbeat = events.find(([event]) => event === "heartbeat");
  assert.equal(heartbeat[1].rssMb, 815);
  assert.equal(heartbeat[1].heapUsedMb, 100);
  assert.equal(heartbeat[1].eventLoopLagMs, 20_000);
});

test("rejects heartbeat intervals that Node would coerce into a log storm", () => {
  assert.equal(resolveHeartbeatMs(undefined), 30_000);
  assert.equal(resolveHeartbeatMs("60000"), 60_000);
  for (const value of ["0", "-1", "1.5", "Infinity", "2147483648"]) {
    assert.throws(() => resolveHeartbeatMs(value), /positive integer/);
  }

  const events = [];
  assert.throws(() => startRuntimeDiagnostics({
    env: { REVISOR_HEARTBEAT_MS: "-1" },
    write: (event, detail) => events.push([event, detail]),
  }), /positive integer/);
  assert.equal(events[0][0], "service_start_failed");
});

test("stop cancels a heartbeat that is waiting for the event loop", () => {
  const events = [];
  let beat;
  let immediate;
  const cancelled = [];
  const diagnostics = startRuntimeDiagnostics({
    env: {},
    write: (event) => events.push(event),
    setInterval: (callback) => {
      beat = callback;
      return "interval";
    },
    setImmediate: (callback) => {
      immediate = callback;
      return "immediate";
    },
    clearInterval: (handle) => cancelled.push(handle),
    clearImmediate: (handle) => cancelled.push(handle),
    on: () => {},
    off: () => {},
  });

  beat();
  diagnostics.stop();
  immediate();

  assert.deepEqual(cancelled, ["interval", "immediate"]);
  assert.deepEqual(events, ["service_started"]);
});
