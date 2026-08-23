// An external verification is evidence about one exact commit.  Keeping this
// predicate small and shared prevents the board, merge-risk, and disposition
// from disagreeing about whether that evidence is still current.
export function externalVerificationClears(pullRequest) {
  const verification = pullRequest?.externalVerification;
  return verification?.decision === "accept"
    && typeof verification.headSha === "string"
    && verification.headSha === pullRequest?.headSha;
}

export function externalVerificationDecision(pullRequest) {
  const verification = pullRequest?.externalVerification;
  if (!verification) return null;
  return {
    source: verification.source,
    by: verification.by,
    at: verification.at,
    runId: verification.runId,
    current: externalVerificationClears(pullRequest),
  };
}
