import { LocalPrStore } from "../../src/state-store.mjs";

const [, , statePath, identifier, operation = "create"] = process.argv;
process.send?.({ type: "ready" });
process.once("message", (message) => {
  if (message?.type !== "start") return;
  try {
    const store = new LocalPrStore({
      path: statePath,
      createId: () => `pr-${identifier}`,
      now: () => `2026-08-10T00:00:${String(identifier).padStart(2, "0")}.000Z`,
    });
    const pullRequest = {
      repository: "LUDIARS/Revisor",
      title: `concurrent ${identifier}`,
      headSha: operation === "deduplicate"
        ? "a".repeat(40)
        : String(identifier).padStart(40, "0"),
    };
    if (operation === "deduplicate") store.createPullRequestIfAbsent(pullRequest);
    else store.createPullRequest(pullRequest);
    process.disconnect?.();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
    process.disconnect?.();
  }
});
