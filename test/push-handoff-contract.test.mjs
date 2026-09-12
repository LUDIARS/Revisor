import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { compareRemoteRefs, handoffPushArgs, parsePushHandoff, ZERO_SHA } from "../src/push-handoff-contract.mjs";

const source = () => ({ id: "e58bfe65-fcdd-4fa4-a9c7-465308a1f79b", repository: "LUDIARS/Product",
  cwd: resolve("Product"), reason: "Replace approved history", updates: [
    { ref: "refs/heads/main", oldSha: "1".repeat(40), newSha: "2".repeat(40) },
    { ref: "refs/tags/v0.1.0", oldSha: "3".repeat(40), newSha: "4".repeat(40) },
  ] });

test("handoff fixes both old/new SHA pairs and uses atomic explicit leases", () => {
  const h = parsePushHandoff(source());
  const args = handoffPushArgs(h, "https://github.com/LUDIARS/Product.git");
  assert.deepEqual(args, ["push", "--atomic", `--force-with-lease=refs/heads/main:${"1".repeat(40)}`,
    `--force-with-lease=refs/tags/v0.1.0:${"3".repeat(40)}`, "https://github.com/LUDIARS/Product.git",
    `${"2".repeat(40)}:refs/heads/main`, `${"4".repeat(40)}:refs/tags/v0.1.0`]);
});

test("handoff rejects options, pseudo-refs, deletes, duplicate refs and forged approval", () => {
  for (const ref of ["--all", "HEAD", "refs/heads/a..b", "refs/heads/a.lock", "refs/heads/a/", "refs/tags/a:b"]) {
    const h = source(); h.updates[0].ref = ref;
    assert.throws(() => parsePushHandoff(h));
  }
  const deletion = source(); deletion.updates[0].newSha = ZERO_SHA;
  assert.throws(() => parsePushHandoff(deletion));
  const duplicate = source(); duplicate.updates.push(duplicate.updates[0]);
  assert.throws(() => parsePushHandoff(duplicate));
  assert.throws(() => parsePushHandoff({ ...source(), approved: true }));
});

test("remote comparison reads tag object IDs, requires all refs, and recognizes create-only", () => {
  const h = source();
  assert.equal(compareRemoteRefs(`${"2".repeat(40)}\trefs/heads/main\n${"4".repeat(40)}\trefs/tags/v0.1.0`, h.updates, "newSha"), true);
  assert.equal(compareRemoteRefs(`${"2".repeat(40)}\trefs/heads/main`, h.updates, "newSha"), false);
  assert.equal(compareRemoteRefs("", [{ ref: "refs/heads/new", oldSha: ZERO_SHA }], "oldSha"), true);
});
