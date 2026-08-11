export const REVIEW_LANES = Object.freeze({
  STANDARD: "standard",
  FAST: "fast",
});

/** @implements SPEC-REVIEW-FAST-LANE-DURABILITY */
export function reviewLaneFromOptIn(value, field = "fast_lane") {
  if (value === undefined || value === false) return REVIEW_LANES.STANDARD;
  if (value === true) return REVIEW_LANES.FAST;
  throw new Error(`${field} must be a boolean.`);
}

export function normalizeReviewLane(value) {
  return value === REVIEW_LANES.FAST ? REVIEW_LANES.FAST : REVIEW_LANES.STANDARD;
}

export function defaultFastLaneSlots(workerCount) {
  return workerCount >= 2 ? 1 : 0;
}

// Keep at least one standard slot. A one-worker installation cannot reserve a
// lane without stealing its only standard slot, so fast lane is unavailable.
/** @implements SPEC-REVIEW-FAST-LANE-CAPACITY */
export function fastLaneReservation(workerCount, configuredSlots = undefined) {
  if (!Number.isInteger(workerCount) || workerCount < 1) {
    throw new TypeError("Review worker count must be a positive integer.");
  }
  const slots = configuredSlots ?? defaultFastLaneSlots(workerCount);
  const valid = Number.isInteger(slots)
    && slots >= 0
    && slots <= 2
    && slots < workerCount
    && (workerCount === 1 ? slots === 0 : slots >= 1);
  if (!valid) {
    throw new TypeError("Fast-lane slots must be 1 or 2 and leave one standard review slot.");
  }
  return slots;
}
