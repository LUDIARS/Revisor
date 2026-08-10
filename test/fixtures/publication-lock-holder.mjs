import { closeSync, openSync, rmSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { PublicationCoordinator } from "../../src/publication-coordinator.mjs";

const [, , lockPath, markerPath] = process.argv;
process.send?.({ type: "ready" });
process.once("message", async (message) => {
  if (message?.type !== "start") return;
  try {
    const coordinator = new PublicationCoordinator({ lockPath });
    await coordinator.run(async () => {
      const handle = openSync(markerPath, "wx");
      try {
        await delay(100);
      } finally {
        closeSync(handle);
        rmSync(markerPath, { force: true });
      }
    });
    process.disconnect?.();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
    process.disconnect?.();
  }
});
