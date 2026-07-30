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
    reviewPlan: null,
    mergeRisk: null,
    runtimeVerification: null,
    autoMerge: null,
  };
}

export class LocalPrReporter {
  constructor(store, { afterCompleted = null, notifyCompletion = null } = {}) {
    if (!store || typeof store.updatePullRequest !== "function") {
      throw new TypeError("Local PR reporter requires a state store.");
    }
    // 通知は終局状態の PR レコードを読んで組み立てる。読めない store を黙って
    // 受け取ると、送信側の catch に飲まれて「通知が一度も来ない」だけになる。
    if (notifyCompletion && typeof store.getPullRequest !== "function") {
      throw new TypeError("Completion notices require a state store that can read pull requests.");
    }
    this.store = store;
    this.afterCompleted = afterCompleted;
    this.notifyCompletion = notifyCompletion;
  }

  // 終局状態に着いたときだけ、投稿元セッションへ 1 回知らせる。通知は best-effort:
  // 送信失敗が審査結果やジョブの成否を変えてはならない (throw する reporter は
  // キューから worker 失敗として扱われる)。
  async #announce(localPrId) {
    if (!this.notifyCompletion) return;
    try {
      const pullRequest = this.store.getPullRequest(localPrId);
      if (pullRequest) await this.notifyCompletion(pullRequest);
    } catch {
      // 通知は落としてよい。
    }
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
      reviewPlan: job.result?.plan ?? null,
      mergeRisk: job.result?.mergeRisk ?? null,
      runtimeVerification: job.result?.runtimeVerification ?? null,
    });
    // Automatic merging is a post-review decision, so it hangs off the completed
    // projection rather than the runner: the runner executes in a worker process
    // and owns no local Git ref advancement beyond the reviewed head.
    // A refused or failed automatic merge must not turn a successful review into
    // a failed job: the queue treats a throwing reporter as a worker failure.
    if (this.afterCompleted) {
      try {
        await this.afterCompleted(job.request.localPrId);
      } catch {
        // The attempt records its own outcome on the pull request.
      }
    }
    // 自動マージの後に送る: マージ済みかどうかまで含めた最終状態を 1 通で伝える。
    await this.#announce(job.request.localPrId);
  }

  async failed(job) {
    this.store.updatePullRequest(job.request.localPrId, {
      checkStatus: "failed",
      error: job.error || "The local review worker failed.",
    });
    // 失敗も終局状態。ここで黙ると投稿側は running のまま待ち続ける。
    await this.#announce(job.request.localPrId);
  }
}
