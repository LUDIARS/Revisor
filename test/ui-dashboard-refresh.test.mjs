import assert from "node:assert/strict";
import test from "node:test";
import { createVisibleRefreshLoop } from "../src/ui-visible-refresh-loop.mjs";
import { renderDashboardPage } from "../src/ui-dashboard-page.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function clock() {
  const timers = new Map();
  let next = 0;
  return {
    timers,
    schedule(fn, delay) { const id = ++next; timers.set(id, { fn, delay }); return id; },
    cancel(id) { timers.delete(id); },
    fire() {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      timer.fn();
    },
  };
}

test("refreshes do not overlap; changes during a read produce one fresh trailing read", async () => {
  const time = clock();
  const first = deferred();
  let calls = 0;
  const loop = createVisibleRefreshLoop({
    ...time, isVisible: () => true, onError: assert.fail,
    refresh: () => { calls++; return calls === 1 ? first.promise : Promise.resolve(); },
  });
  const running = loop.requestRefresh();
  await flush();
  for (let i = 0; i < 5; i++) assert.equal(loop.requestRefresh(), running);
  assert.equal(calls, 1);
  assert.equal(time.timers.size, 0);
  first.resolve();
  await running;
  assert.equal(calls, 2);
  assert.equal(time.timers.size, 1);
  assert.equal([...time.timers.values()][0].delay, 3000);
  loop.stop();
  assert.equal(time.timers.size, 0);
});

test("hidden pages cancel the timer and defer updates until visible, including in-flight completion", async () => {
  const time = clock();
  const first = deferred();
  let visible = true;
  let calls = 0;
  const loop = createVisibleRefreshLoop({
    ...time, isVisible: () => visible, onError: assert.fail,
    refresh: () => { calls++; return calls === 1 ? first.promise : Promise.resolve(); },
  });
  const running = loop.requestRefresh();
  await flush();
  visible = false;
  void loop.visibilityChanged();
  void loop.requestRefresh();
  first.resolve();
  await running;
  assert.equal(calls, 1);
  assert.equal(time.timers.size, 0);
  visible = true;
  await loop.visibilityChanged();
  assert.equal(calls, 2);
  visible = false;
  await loop.visibilityChanged();
  assert.equal(time.timers.size, 0);
  loop.stop();
});

test("a failed refresh reports the failure and recovers on the next completion-based interval", async () => {
  const time = clock();
  const errors = [];
  let calls = 0;
  const loop = createVisibleRefreshLoop({
    ...time, isVisible: () => true, onError: (error) => errors.push(error.message),
    refresh: async () => { if (++calls === 1) throw new Error("unavailable"); },
  });
  await loop.requestRefresh();
  assert.deepEqual(errors, ["unavailable"]);
  time.fire();
  await flush();
  assert.equal(calls, 2);
  assert.equal(time.timers.size, 1);
  loop.stop();
});

function element() {
  return {
    children: [], value: "", textContent: "", listeners: {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(type, callback) { this.listeners[type] = callback; },
  };
}

test("generated dashboard uses open summaries and waits for sibling requests even when one fails", async () => {
  const time = clock();
  const elements = new Map();
  const document = {
    hidden: false, listeners: {}, createElement: element,
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, element());
      return elements.get(selector);
    },
    addEventListener(type, callback) { this.listeners[type] = callback; },
  };
  const calls = [];
  const delayed = deferred();
  let firstRound = true;
  const fetch = async (path, options) => {
    calls.push({ path, options });
    if (firstRound && path === "/api/jobs") throw new Error("jobs offline");
    if (firstRound && path === "/api/releases") return delayed.promise;
    const data = path === "/api/jobs" ? { running: 0, queued: 0, jobs: [] }
      : path === "/api/repositories" ? { repositories: [{ repository: "Org/Repo", testCases: [] }] }
        : path === "/api/releases" ? { projects: [] }
          : { pullRequests: [{ repository: "org/repo", status: "open" }] };
    return { ok: true, json: async () => data };
  };
  const script = renderDashboardPage("nonce").match(/<script nonce="nonce">([\s\S]*?)<\/script>/)[1];
  new Function("document", "fetch", "setTimeout", "clearTimeout", script)(document, fetch, time.schedule, time.cancel);
  await flush();
  assert.equal(calls.length, 4);
  assert.ok(calls.some(({ path }) => path === "/api/local-prs?view=summary&state=open"));
  assert.ok(calls.every(({ options }) => options.headers["X-Revisor-Session"] === "nonce"));
  assert.equal(time.timers.size, 0, "failed jobs must not unlock another round before releases settles");
  delayed.resolve({ ok: true, json: async () => ({ projects: [] }) });
  await flush();
  assert.equal(elements.get("#queue").textContent, "jobs offline");
  assert.equal(time.timers.size, 1);
  firstRound = false;
  time.fire();
  await flush();
  assert.equal(calls.length, 8);
  const row = elements.get("#repository-rows").children[0];
  assert.equal(row.children.at(-1).textContent, "1");
  document.hidden = true;
  document.listeners.visibilitychange();
  assert.equal(time.timers.size, 0);
});
