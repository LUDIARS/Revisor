import assert from "node:assert/strict";
import test from "node:test";
import { fetchElegantiaAntipatterns, normalizeAntipattern } from "../src/elegantia-antipatterns.mjs";

const ITEM = {
  id: "AP01",
  revision: 1,
  title: "Web/API の応答が 1 秒を超える",
  summary: "summary",
  detect: ["リクエスト中の同期外部呼び出し"],
  fix: "キャッシュか裏更新にする",
  augur: { metric: "api_latency", threshold: 1000, unit: "ms", percentile: 95, scope: "*" },
  source: "catalog",
  sourceRef: null,
  createdAt: "2026-10-17T00:00:00Z",
};

function okResponse(items) {
  return { ok: true, status: 200, async json() { return { items }; } };
}

test("fetches the catalog from /api/antipatterns and keeps reviewer fields only", async () => {
  let requested;
  const result = await fetchElegantiaAntipatterns({
    baseUrl: "http://elegantia.test",
    cache: new Map(),
    fetchImpl: async (url, options) => {
      requested = { url, options };
      return okResponse([ITEM, { id: "AP02", title: "no detect", fix: "x" }]);
    },
  });
  assert.equal(requested.url.pathname, "/api/antipatterns");
  assert.equal(requested.options.method, "GET");
  assert.ok(requested.options.signal);
  assert.equal(result.status, "fetched");
  assert.equal(result.reason, null);
  assert.deepEqual(result.items, [{ id: "AP01", title: ITEM.title, detect: ITEM.detect, fix: ITEM.fix }]);
  assert.equal(result.skipped, 1);
});

test("reuses a fresh catalog without calling Elegantia again", async () => {
  const cache = new Map();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return okResponse([ITEM]); };
  let now = 1_000;
  const clock = () => now;
  await fetchElegantiaAntipatterns({ baseUrl: "http://elegantia.test", cache, fetchImpl, clock });
  now += 1_000;
  const second = await fetchElegantiaAntipatterns({ baseUrl: "http://elegantia.test", cache, fetchImpl, clock });
  assert.equal(calls, 1);
  assert.equal(second.status, "cached");
  assert.equal(second.items.length, 1);
});

test("falls back to the previous catalog as stale when Elegantia fails", async () => {
  const cache = new Map();
  let now = 0;
  const clock = () => now;
  await fetchElegantiaAntipatterns({
    baseUrl: "http://elegantia.test", cache, clock, fetchImpl: async () => okResponse([ITEM]),
  });
  now += 10 * 60_000;
  const result = await fetchElegantiaAntipatterns({
    baseUrl: "http://elegantia.test",
    cache,
    clock,
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  assert.equal(result.status, "stale");
  assert.equal(result.reason, "HTTP 503");
  assert.equal(result.items[0].id, "AP01");
});

test("returns unavailable with a reason instead of throwing when nothing was cached", async () => {
  const result = await fetchElegantiaAntipatterns({
    baseUrl: "http://elegantia.test",
    cache: new Map(),
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.items, []);
  assert.equal(result.reason, "request failed");
});

test("aborts a slow Elegantia after the short timeout", async () => {
  const result = await fetchElegantiaAntipatterns({
    baseUrl: "http://elegantia.test",
    cache: new Map(),
    timeoutMs: 20,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    }),
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.reason, "timed out after 20ms");
});

test("rejects an invalid payload and an unresolvable port as unavailable", async () => {
  const invalid = await fetchElegantiaAntipatterns({
    baseUrl: "http://elegantia.test",
    cache: new Map(),
    fetchImpl: async () => ({ ok: true, status: 200, async json() { return { rows: [] }; } }),
  });
  assert.equal(invalid.status, "unavailable");
  assert.equal(invalid.reason, "invalid response");
  const unresolved = await fetchElegantiaAntipatterns({
    cwd: "Z:/no-such-workspace",
    cache: new Map(),
    fetchImpl: async () => okResponse([ITEM]),
  });
  assert.equal(unresolved.status, "unavailable");
  assert.match(unresolved.reason, /^port resolution failed: /);
});

test("normalizeAntipattern requires an AP id, title, detect signs and fix", () => {
  assert.equal(normalizeAntipattern({ ...ITEM, id: "X1" }), null);
  assert.equal(normalizeAntipattern({ ...ITEM, detect: [] }), null);
  assert.equal(normalizeAntipattern({ ...ITEM, fix: " " }), null);
  assert.equal(normalizeAntipattern({ ...ITEM, id: "AP-G-0123456789ab" }).id, "AP-G-0123456789ab");
});
