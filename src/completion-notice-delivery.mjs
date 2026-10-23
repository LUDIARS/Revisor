import { createHash, randomUUID } from 'node:crypto';

/** Identity includes the review attempt and terminal state, never the session id or message. */
function noticeKey(pr) {
  return createHash('sha256').update(JSON.stringify([
    pr.id, pr.jobId, pr.headSha, pr.checkStatus, pr.status, pr.mergeCommitSha,
  ])).digest('hex');
}

/**
 * Persist before I/O. Cc acceptance is not proof of agent consumption.
 * An ambiguous timeout/process exit must not trigger a duplicate inject.
 * @implements SPEC-REVIEW-COMPLETION-EVIDENCE
 */
export async function deliverCompletionNotice({ store, pullRequest, send, now = () => new Date().toISOString() }) {
  const key = noticeKey(pullRequest);
  const attempt = randomUUID();
  let claimed = false;
  store.updatePullRequestWith(pullRequest.id, current => {
    if (noticeKey(current) !== key || current.completionNotice?.key === key) return {};
    claimed = true;
    return { completionNotice: { key, attempt, state: 'sending', startedAt: now(), finishedAt: null } };
  });
  if (!claimed) return false;

  let accepted = false;
  try { accepted = await send(pullRequest) === true; }
  catch { /* Transport failure is ambiguous; retain evidence, never alter the review verdict. */ }
  const state = accepted ? 'accepted' : 'unconfirmed';
  let recorded = false;
  store.updatePullRequestWith(pullRequest.id, current => {
    if (noticeKey(current) !== key || current.completionNotice?.attempt !== attempt) return {};
    recorded = true;
    return { completionNotice: { ...current.completionNotice, state, finishedAt: now() } };
  });
  // Expose the outcome in the existing PR timeline without storing response bodies or secrets.
  if (recorded) store.appendPullRequestEvent(pullRequest.id, {
    event: `completion_notice_${state}`,
    tone: accepted ? 'success' : 'warning',
    message: accepted
      ? 'Cc accepted the completion notice; agent consumption is not confirmed.'
      : 'Completion notice acceptance is unconfirmed. Reconcile Cc receipt before any resend.',
  });
  return accepted;
}
