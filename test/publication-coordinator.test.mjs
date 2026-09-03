import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PublicationCoordinator } from "../src/publication-coordinator.mjs";
import { runBarrierChildren } from "./helpers/barrier-children.mjs";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

const HOLDER_PATH = fileURLToPath(
  new URL("./fixtures/publication-lock-holder.mjs", import.meta.url),
);

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

test("serializes publication operations across separate CLI processes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "revisor-publication-"));
  const lockPath = join(directory, "publication");
  const markerPath = join(directory, "active");
  try {
    await runBarrierChildren(HOLDER_PATH, [
      [lockPath, markerPath],
      [lockPath, markerPath],
    ]);
  } finally {
    removeFixture(directory);
  }
});
