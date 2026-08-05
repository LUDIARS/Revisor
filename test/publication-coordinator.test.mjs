import assert from "node:assert/strict";
import test from "node:test";
import { PublicationCoordinator } from "../src/publication-coordinator.mjs";

test("serializes merge and manual release operations after failures", async () => {
  const coordinator = new PublicationCoordinator();
  const events = [];
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = coordinator.run(async () => {
    events.push("first:start");
    await gate;
    events.push("first:end");
    throw new Error("first failed");
  });
  const second = coordinator.run(async () => {
    events.push("second:start");
    events.push("second:end");
    return "done";
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await assert.rejects(first, /first failed/);
  assert.equal(await second, "done");
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});
