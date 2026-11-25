import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contract } from "../src/contract-runtime.mjs";
import { normalizeForcedReviewModel } from "../src/forced-review-model.mjs";
import { containsLocalPath, containsPrivateIp } from "../src/host-identifiers.mjs";

function isolatedContractLog(t) {
  const directory = mkdtempSync(join(tmpdir(), "revisor-contract-sampling-"));
  const previous = process.env.VESTIGIUM_LOGS_DIR;
  process.env.VESTIGIUM_LOGS_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.VESTIGIUM_LOGS_DIR;
    else process.env.VESTIGIUM_LOGS_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
  return join(directory, "contracts.jsonl");
}

function readEvents(log) {
  return readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line));
}

test("the three high-volume contracts record successful calls below the 1% threshold", (t) => {
  const log = isolatedContractLog(t);
  let draw = 0.01;
  t.mock.method(Math, "random", () => draw);

  const callContracts = () => {
    assert.equal(normalizeForcedReviewModel("sol"), "sol");
    assert.equal(containsPrivateIp("plain text"), false);
    assert.equal(containsLocalPath("plain text"), false);
  };

  callContracts();
  assert.equal(existsSync(log), false);

  draw = 0.009;
  callContracts();
  assert.deepEqual(readEvents(log).map(({ ctx }) => [ctx.contract, ctx.phase]), [
    ["C-27", "ok"],
    ["C-12", "ok"],
    ["C-13", "ok"],
  ]);
});

test("sampling keeps violations and exceptions from pre and post predicates", async (t) => {
  const log = isolatedContractLog(t);
  t.mock.method(Math, "random", () => 0.5);
  const violation = contract(() => 7, {
    contractId: "sampling-violation",
    sample: 0.01,
    pre: () => false,
    post: () => false,
  });
  const throwPredicate = () => { throw new Error("predicate error"); };
  const predicateError = contract(async () => 9, {
    contractId: "sampling-exception",
    sample: 0.01,
    pre: throwPredicate,
    post: throwPredicate,
  });

  assert.equal(violation(), 7);
  assert.equal(await predicateError(), 9);
  assert.deepEqual(readEvents(log).map(({ msg, ctx }) => [ctx.contract, msg, ctx.phase]), [
    ["sampling-violation", "contract violated", "pre"],
    ["sampling-violation", "contract violated", "post"],
    ["sampling-exception", "contract predicate threw", "pre"],
    ["sampling-exception", "contract predicate threw", "post"],
  ]);
});
