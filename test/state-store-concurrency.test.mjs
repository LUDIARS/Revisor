import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { LocalPrStore } from "../src/state-store.mjs";
import { runBarrierChildren } from "./helpers/barrier-children.mjs";
import { removeFixture } from "./helpers/fixture-cleanup.mjs";

const WRITER_PATH = fileURLToPath(new URL("./fixtures/state-store-writer.mjs", import.meta.url));

test("concurrent CLI processes preserve every PR and allocate unique numbers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "revisor-state-concurrent-"));
  const statePath = join(directory, "state.json");
  try {
    const identifiers = Array.from({ length: 8 }, (_, index) => String(index + 1));
    await runBarrierChildren(
      WRITER_PATH,
      identifiers.map((identifier) => [statePath, identifier]),
    );
    const pullRequests = new LocalPrStore({ path: statePath }).listPullRequests();
    assert.equal(pullRequests.length, identifiers.length);
    assert.deepEqual(
      pullRequests.map((pullRequest) => pullRequest.number).sort((left, right) => left - right),
      identifiers.map((_, index) => index + 1),
    );
  } finally {
    removeFixture(directory);
  }
});

test("concurrent submissions of the same head reuse one PR record", async () => {
  const directory = mkdtempSync(join(tmpdir(), "revisor-state-deduplicate-"));
  const statePath = join(directory, "state.json");
  try {
    const identifiers = Array.from({ length: 8 }, (_, index) => String(index + 1));
    await runBarrierChildren(
      WRITER_PATH,
      identifiers.map((identifier) => [statePath, identifier, "deduplicate"]),
    );
    const pullRequests = new LocalPrStore({ path: statePath }).listPullRequests();
    assert.equal(pullRequests.length, 1);
    assert.equal(pullRequests[0].number, 1);
  } finally {
    removeFixture(directory);
  }
});
