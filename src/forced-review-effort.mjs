import { readSettings } from "./config.mjs";

const FORCEABLE_REVIEW_EFFORTS = new Set(["low", "medium", "high"]);

export const FORCEABLE_REVIEW_EFFORT_IDS = Object.freeze([...FORCEABLE_REVIEW_EFFORTS]);

/** @implements SPEC-FORCED-REVIEW-MODEL */
export function isForcedReviewEffort(value) {
  return value === "" || FORCEABLE_REVIEW_EFFORTS.has(value);
}

/** @implements SPEC-FORCED-REVIEW-MODEL */
export function configuredForcedReviewEffort(env = process.env, read = readSettings) {
  try {
    const value = read(env)?.forcedReviewEffort;
    return isForcedReviewEffort(value) ? value : "";
  } catch {
    // A review worker must remain usable when optional settings are unreadable.
    return "";
  }
}
