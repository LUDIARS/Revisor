/** Bounded compiler execution and scheduling limits for native analysis. */
export const NATIVE_COMPILER_TIMEOUT_MS = 60_000;
export const NATIVE_WORKERS = 2;

export function nativeSchedulingBudget(processCount) {
  // Allow every queued compiler process its existing timeout, plus one round for
  // scheduling. Each analyzed file runs a diagnostics, an expansion and an analyzer pass
  // (a probed header up to three more: its probe and two syntax checks), and analyzeNative
  // still caps the batch at 256 analyzed files.
  return Math.max(120_000,
    (Math.ceil(processCount / NATIVE_WORKERS) + 1) * NATIVE_COMPILER_TIMEOUT_MS);
}
