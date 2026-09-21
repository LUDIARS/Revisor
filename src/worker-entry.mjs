/** @implements SPEC-COMPLETE-DISCORD-REVIEW-REPORT */
import { createPrReviewRunner } from "./runner.mjs";
import { runReviewWork } from "./review-work.mjs";

const runner = createPrReviewRunner({
  cwd: process.cwd(),
  env: process.env,
});

process.on("message", async (message) => {
  if (!message || message.type !== "run" || typeof message.id !== "string") return;
  try {
    const result = message.request?.stage
      ? await runReviewWork(message.request, {
        onProgress: (progress) => new Promise((resolve, reject) => {
          if (!process.send) return resolve();
          process.send({ type: "progress", id: message.id, progress: { ...progress, at: new Date().toISOString() } },
            (error) => error ? reject(error) : resolve());
        }),
      })
      : await runner(message.request);
    process.send?.({ type: "result", id: message.id, result });
  } catch (error) {
    process.send?.({
      type: "error",
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
