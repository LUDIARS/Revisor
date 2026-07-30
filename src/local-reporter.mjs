function analysisProjection(result) {
  const analysis = result?.analysis;
  if (!analysis) return null;
  return {
    domain: analysis.domain,
    quality: analysis.quality,
    architecture: analysis.architecture,
    baselineComplexityScore: result.baselineComplexityScore,
    complexityScoreDelta: result.complexityScoreDelta,
    source: result.analysisSource,
  };
}

// The review outcome fields owned by `completed`, cleared. A re-review resolves
// fresh refs, so the previous run's outcome must not be read as the current one.
export function pendingReviewProjection() {
  return {
    reviewedHeadSha: null,
    reviewer: null,
    ci: [],
    anatomia: null,
    leakage: null,
    security: null,
    reasons: [],
    advisories: [],
    humanQuestion: null,
  };
}

export class LocalPrReporter {
  constructor(store) {
    if (!store || typeof store.updatePullRequest !== "function") {
      throw new TypeError("Local PR reporter requires a state store.");
    }
    this.store = store;
  }

  async queued(job) {
    this.store.updatePullRequest(job.request.localPrId, {
      jobId: job.id,
      checkStatus: "queued",
    });
  }

  async running(job) {
    this.store.updatePullRequest(job.request.localPrId, {
      checkStatus: "running",
    });
  }

  async completed(job) {
    const passed = job.result?.conclusion === "success";
    this.store.updatePullRequest(job.request.localPrId, {
      checkStatus: passed ? "test_ok" : "action_required",
      reviewedHeadSha: job.result?.reviewedHeadSha ?? job.request.headSha,
      reviewer: job.result?.reviewer ?? null,
      ci: job.result?.ci ?? [],
      anatomia: analysisProjection(job.result),
      leakage: job.result?.leakage ?? null,
      security: job.result?.security ?? null,
      reasons: job.result?.reasons ?? [],
      advisories: job.result?.advisories ?? [],
      humanQuestion: job.result?.humanQuestion ?? null,
    });
  }

  async failed(job) {
    this.store.updatePullRequest(job.request.localPrId, {
      checkStatus: "failed",
      error: job.error || "The local review worker failed.",
    });
  }
}
