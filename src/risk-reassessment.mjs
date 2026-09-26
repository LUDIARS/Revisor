// @spec SPEC-RISK-REASSESSMENT: 高スコアPRの再審査と通知
import { isSoleGeniusHumanDecisionHold } from "./human-decision.mjs";
import { withFileLock } from "./file-lock.mjs";
import { effectiveMergeRisk } from "./merge-risk.mjs";

export const RISK_REASSESSMENT_THRESHOLD = 100;

// One durable cycle per PR. Autofix may advance HEAD; that never grants a new cycle.
/** @implements SPEC-RISK-REASSESSMENT */
export function riskReassessmentAction(pr, enabled) {
  if (!enabled || !pr || pr.status !== "open" || ["queued", "running"].includes(pr.checkStatus)) return "none";
  const score = effectiveMergeRisk(pr)?.score;
  const cycle = pr.riskReassessment;
  if (cycle?.state === "held") return "hold";
  if (cycle?.state === "completed") {
    return Number.isFinite(score) && score < 100 && pr.checkStatus === "test_ok" ? "clear" : "hold";
  }
  if (cycle?.state === "reserved" || cycle?.state === "failed") return "hold";
  if (!Number.isFinite(score) || score < 100) return "none";
  // A question is an explicit human boundary; a second model must not answer it.
  return pr.humanQuestion || isSoleGeniusHumanDecisionHold(pr) ? "hold" : "retry";
}

/** @implements SPEC-RISK-REASSESSMENT */
export async function notifyRiskOnce({ store, id, event, notify, now = () => new Date().toISOString() }) {
  let claimed = false;
  const reserved = store.updatePullRequestWith(id, (pr) => {
    if (pr.riskNotices?.[event]) return {};
    claimed = true;
    return { riskNotices: { ...pr.riskNotices, [event]: { status: "unknown", at: now() } } };
  });
  if (!claimed) return;
  let status = "unavailable";
  try { status = notify ? await notify(event, reserved) : "unavailable"; }
  catch { status = "unknown"; /* The remote outcome is unknown: never blindly replay a mention. */ }
  store.updatePullRequestWith(id, (pr) => ({
    riskNotices: { ...pr.riskNotices, [event]: { status, at: now() } },
  }));
}

const inMemoryLocks = new WeakMap();
/** @implements SPEC-RISK-REASSESSMENT */
export async function handleRiskReassessment(options) {
  const { store } = options;
  const run = () => performRiskReassessment(options);
  if (store.path) return withFileLock(store.path + ".lifecycle", run, { label: "risk-reassessment" });
  // In-memory adapters have no cross-process state. Serialize them for the same semantics.
  const previous = inMemoryLocks.get(store) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(run);
  inMemoryLocks.set(store, next);
  try { return await next; }
  finally { if (inMemoryLocks.get(store) === next) inMemoryLocks.delete(store); }
}

/** @implements SPEC-RISK-REASSESSMENT */
async function performRiskReassessment({ store, id, enabled, requeue, notify, now = () => new Date().toISOString() }) {
  let claimed = false;
  const pr = store.getPullRequest(id);
  const action = riskReassessmentAction(pr, enabled);
  if (action === "none" || action === "clear") return false;
  if (action === "retry") {
    const reserved = store.updatePullRequestWith(id, (current) => {
      if (riskReassessmentAction(current, enabled) !== "retry") return {};
      claimed = true;
      return { riskReassessment: { state: "reserved", originHeadSha: current.reviewedHeadSha ?? current.headSha,
        originJobId: current.jobId ?? null, startedAt: now(), attempts: 1,
        initialScore: effectiveMergeRisk(current)?.score, factors: effectiveMergeRisk(current)?.factors ?? [],
        reasons: current.reasons ?? [] } };
    });
    if (!claimed) return true;
    try { await requeue(reserved); return true; }
    catch {
      store.updatePullRequestWith(id, (current) => ({ riskReassessment: {
        ...current.riskReassessment, state: "failed", failure: "Automatic repair/review could not be queued; inspect the review record before retrying.",
      } }));
    }
  }
  const held = store.updatePullRequestWith(id, (current) => {
    // A concurrent worker may already have started; never replace its projection.
    if (["queued", "running"].includes(current.checkStatus) || current.status !== "open") return {};
    return { riskReassessment: { ...current.riskReassessment, state: "held", completedAt: now() } };
  });
  if (held.riskReassessment?.state === "held") await notifyRiskOnce({ store, id, event: "needs_human", notify, now });
  return true;
}

/** @implements SPEC-RISK-REASSESSMENT */
export function completedRiskCycle(pr, job, failed = false) {
  const cycle = pr.riskReassessment;
  if (cycle?.state !== "reserved" || cycle.originJobId === job.id || job.request.riskReassessment !== true) return {};
  return { riskReassessment: { ...cycle, state: failed ? "failed" : "completed", jobId: job.id,
    reviewedHeadSha: job.result?.reviewedHeadSha ?? job.request.headSha } };
}
