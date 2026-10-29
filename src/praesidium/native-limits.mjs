/** Bounded compiler execution and scheduling limits for native analysis. */
export const NATIVE_COMPILER_TIMEOUT_MS = 60_000;
export const NATIVE_WORKERS = 2;

export function nativeSchedulingBudget(unitCount) {
  // Allow every queued unit its existing timeout, plus one round for scheduling.
  // analyzeNative still caps the batch at 256 analyzed translation units.
  return Math.max(120_000,
    (Math.ceil(unitCount / NATIVE_WORKERS) + 1) * NATIVE_COMPILER_TIMEOUT_MS);
}
