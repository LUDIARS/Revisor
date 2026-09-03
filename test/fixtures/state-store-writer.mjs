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
    // cause まで書く。 RevisorError は "Revisor state is unreadable" としか名乗らないので、
    // これが無いと並行書き込みが落ちた本当の理由 (EPERM / SQLITE_BUSY 等) が親から見えない。
    process.stderr.write(`${formatError(error)}\n`);
    process.exitCode = 1;
    process.disconnect?.();
  }
});

/** error.cause を辿って 1 本の文字列にする (Error.stack は cause を含まない)。 */
function formatError(error) {
  const parts = [];
  for (let current = error, depth = 0; current && depth < 5; current = current.cause, depth += 1) {
    if (!(current instanceof Error)) {
      parts.push(String(current));
      break;
    }
    const code = current.code ? ` [${current.code}]` : "";
    parts.push(`${depth ? "caused by: " : ""}${current.stack ?? current.message}${code}`);
  }
  return parts.join("\n");
}
