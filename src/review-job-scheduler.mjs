import {
  fastLaneReservation,
  normalizeReviewLane,
  REVIEW_LANES,
} from "./review-lane.mjs";

const DEFAULT_QUEUE_CHECK_INTERVAL_MS = 250;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function queuedLane(job) {
  return normalizeReviewLane(job.reviewLane ?? job.request?.reviewLane);
}

/**
 * Drain durable review jobs while keeping fast-lane capacity available.
 *
 * The persistent queue is shared by independent submitter processes, so a fast
 * job can arrive while standard work is already running. A short read-only check
 * keeps the reserved capacity responsive without repeatedly mutating the queue.
 *
 * @implements SPEC-REVIEW-FAST-LANE-CAPACITY
 */
export async function drainReviewJobs({
  jobs,
  concurrency,
  run,
  reservation,
  queueCheckIntervalMs = DEFAULT_QUEUE_CHECK_INTERVAL_MS,
}) {
  if (!jobs || typeof jobs.claimNext !== "function" || typeof jobs.state !== "function") {
    throw new TypeError("Review job scheduler requires a persistent job store.");
  }
  if (typeof run !== "function") throw new TypeError("Review job scheduler requires a runner.");
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError("Review job concurrency must be a positive integer.");
  }
  const fastLaneSlots = fastLaneReservation(concurrency, reservation);

  const active = new Set();
  let standardRunning = 0;
  let fastRunning = 0;
  let ran = 0;
  const standardCapacity = concurrency - fastLaneSlots;
  const fastCapacity = fastLaneSlots;

  const launch = async (lane) => {
    const job = await jobs.claimNext({ reviewLane: lane });
    if (!job) return false;
    ran += 1;
    if (lane === REVIEW_LANES.STANDARD) standardRunning += 1;
    else fastRunning += 1;
    let execution;
    execution = Promise.resolve()
      .then(() => run(job))
      .finally(() => {
        active.delete(execution);
        if (lane === REVIEW_LANES.STANDARD) standardRunning -= 1;
        else fastRunning -= 1;
      });
    active.add(execution);
    return true;
  };

  for (;;) {
    let snapshot = jobs.state();
    while (active.size < concurrency) {
      const hasFast = snapshot.jobs.some((job) =>
        job.status === "queued" && queuedLane(job) === REVIEW_LANES.FAST);
      if (hasFast && fastRunning < fastCapacity && await launch(REVIEW_LANES.FAST)) {
        snapshot = jobs.state();
        continue;
      }
      const hasStandard = standardRunning < standardCapacity && snapshot.jobs.some((job) =>
        job.status === "queued" && queuedLane(job) === REVIEW_LANES.STANDARD);
      if (hasStandard && await launch(REVIEW_LANES.STANDARD)) {
        snapshot = jobs.state();
        continue;
      }
      break;
    }

    if (active.size === 0) {
      const heldFast = fastLaneSlots === 0
        ? snapshot.jobs.filter((job) =>
          job.status === "queued" && queuedLane(job) === REVIEW_LANES.FAST).length
        : 0;
      return heldFast > 0 ? { ran, heldFast } : { ran };
    }
    await Promise.race([
      ...active,
      wait(queueCheckIntervalMs),
    ]);
  }
}
