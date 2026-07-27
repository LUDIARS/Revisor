import assert from "node:assert/strict";
import test from "node:test";
import { readServicePort } from "../src/catalog.mjs";

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

test("rejects missing service registration", () => {
  assert.throws(
    () => readServicePort("services:\n", "revisor"),
    /not registered/,
  );
});
