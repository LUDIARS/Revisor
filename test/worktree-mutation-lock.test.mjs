import assert from "node:assert/strict";
import test from "node:test";
import { withWorktreeMutationLock } from "../src/worktree-mutation-lock.mjs";

test("serializes worktree mutations per repository without blocking another repository", async () => {
  const events = [];
  let releaseFirst;
  const first = withWorktreeMutationLock("repo-a", async () => {
    events.push("a:first:start");
    await new Promise((resolve) => { releaseFirst = resolve; });
    events.push("a:first:end");
  });
  const second = withWorktreeMutationLock("repo-a", async () => {
    events.push("a:second");
  });
  const independent = withWorktreeMutationLock("repo-b", async () => {
    events.push("b:independent");
  });

  // The keyed lock crosses two promise continuations (previous completion and
  // operation start), so wait a turn rather than assuming a single microtask.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["a:first:start", "b:independent"]);
  releaseFirst();
  await Promise.all([first, second, independent]);
  assert.deepEqual(events, ["a:first:start", "b:independent", "a:first:end", "a:second"]);
});
