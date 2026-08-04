import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readServicePort } from "../src/catalog.mjs";

const FRAGMENT = readFileSync(
  new URL("../excubitor.catalog.yaml", import.meta.url),
  "utf8",
);

test("reads Revisor and Concordia ports from the Excubitor catalog", () => {
  const catalog = [
    "services:",
    "  - code: revisor",
    "    port: 4240",
    "  - code: concordia",
    "    port: 11111",
    "",
  ].join("\n");
  assert.equal(readServicePort(catalog, "revisor"), 4240);
  assert.equal(readServicePort(catalog, "concordia"), 11111);
});

// Revisor's fragment uses the same service block format as the central catalog.
// Keep that contract readable by the existing parser without assigning the
// operational catalog or this test helper to an application domain.
test("the shipped catalog fragment is readable by Revisor's own catalog parser", () => {
  assert.equal(readServicePort(FRAGMENT, "revisor"), 4240);
});

// The health check is what Excubitor restarts the service on, so it has to point
// at the port the fragment declares, on the address `startRevisor` binds (IPv4
// loopback only — `localhost` may resolve to ::1 and never reach the listener).
test("the catalog fragment health check targets the declared port on IPv4 loopback", () => {
  const url = FRAGMENT.match(/^      url:\s*(\S+)\s*$/m)?.[1];
  assert.equal(url, `http://127.0.0.1:${readServicePort(FRAGMENT, "revisor")}/health`);
});

// `provides` is what other services resolve Revisor through, and `startRevisor`
// binds IPv4 loopback only — a host placeholder here would publish an address
// nothing listens on and that the UI host policy rejects anyway.
test("the catalog fragment publishes Revisor on IPv4 loopback", () => {
  const url = FRAGMENT.match(/^      REVISOR_URL:\s*(\S+)\s*$/m)?.[1];
  assert.equal(url, "http://127.0.0.1:${port}");
});

test("rejects missing service registration", () => {
  assert.throws(
    () => readServicePort("services:\n", "revisor"),
    /not registered/,
  );
});
