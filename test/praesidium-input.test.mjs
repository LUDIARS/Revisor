import test from "node:test";
import assert from "node:assert/strict";
import { compileRouteGuard } from "../src/praesidium/input-guard.mjs";
import { checkWebContracts } from "../src/praesidium/web-contracts.mjs";

const contract = { method: "POST", path: "/items/:id", maxBodyBytes: 128,
  params: { id: { type: "string", format: "slug", maxLength: 20, required: true } },
  query: { page: { type: "integer", min: 1, max: 10 } },
  body: { name: { type: "string", maxLength: 50, required: true } } };
const request = { method: "POST", target: "/items/abc?page=1", contentType: "application/json",
  bodyText: JSON.stringify({ name: "O'Brian 日本語 <text>" }) };

test("validates before routing without treating legitimate text as executable", () => {
  const guard = compileRouteGuard(contract);
  assert.equal(guard(request).ok, true);
  assert.equal(guard(request).query.page, 1);
  assert.equal(Object.getPrototypeOf(guard(request).body), null);
});

test("rejects malformed/ambiguous targets, unknown fields and scalar boundary attacks", () => {
  const guard = compileRouteGuard(contract);
  for (const target of ["/items/%2e%2e", "/items/%252e%252e", "/items/a%2fb", "/items/a%5cb",
    "/items/%ZZ", "/items/a%00", "/items/abc?page=1&page=2", "/items/abc?%70age=1&page=2",
    "/items/abc?__proto__=x", "/items/abc?page=1e0", "/items/abc?page=11", "/items/abc?page[]=1",
    "/items/abc#fragment", "https://example.test/items/abc", "/items/abc?page=1#x"]) {
    assert.equal(guard({ ...request, target }).ok, false, target);
  }
  for (const bodyText of ['{"name":"x","name":"y"}', '{"name":"x","n\\u0061me":"y"}',
    '{"name":"x","__proto__":{}}', '{"name":{}}', '{"name":null}', '{"name":"x","admin":true}',
    '[]', 'null', '{"name":"x"', 'x'.repeat(129)]) {
    assert.equal(guard({ ...request, bodyText }).ok, false, bodyText);
  }
  assert.equal(guard({ ...request, method: "GET" }).status, 405);
  assert.equal(guard({ ...request, contentType: "text/plain" }).status, 415);
  assert.equal(guard({ ...request, bodyText: "あ".repeat(50) }).status, 413);
});

test("compilation rejects invalid contracts and freezes policy semantics", () => {
  assert.throws(() => compileRouteGuard({ ...contract, maxBodyBytes: -1 }));
  assert.throws(() => compileRouteGuard({ ...contract, params: {} }));
  assert.throws(() => compileRouteGuard({ ...contract, query: { q: { type: "string", maxLength: 5, format: "user-regex" } } }));
  const copy = structuredClone(contract);
  const guard = compileRouteGuard(copy);
  copy.body.name.maxLength = 1;
  assert.equal(guard(request).ok, true);
});

test("contract runner requires both acceptance and rejection examples", () => {
  const cases = [{ request, accept: true }, { request: { ...request, target: "/items/.." }, accept: false }];
  assert.equal(checkWebContracts([{ name: "create-item", contract, cases }])[0].status, "passed");
  assert.throws(() => checkWebContracts([{ name: "weak", contract, cases: [cases[0]] }]));
  assert.equal(checkWebContracts([{ name: "wrong", contract, cases: [...cases, { request, accept: false }] }])[0].status, "failed");
});
