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
      reasons: job.result?.reasons ?? [],
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
