import {
  pullRequestLifecycleMessage,
  pullRequestLifecycleTone,
} from "./pr-lifecycle-notice.mjs";

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
    intentReviewCompleted: false,
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
    geniusGuidance: null,
    autoMerge: null,
  };
}

export class LocalPrReporter {
  constructor(store, {
    afterCompleted = null,
    notifyCompletion = null,
    notifyReviewStatus = null,
  } = {}) {
    if (!store || typeof store.updatePullRequest !== "function") {
      throw new TypeError("Local PR reporter requires a state store.");
    }
    if (notifyReviewStatus !== null && typeof notifyReviewStatus !== "function") {
      throw new TypeError("Review status notifier must be a function.");
    }
    // 通知は終局状態の PR レコードを読んで組み立てる。読めない store を黙って
    // 受け取ると、送信側の catch に飲まれて「通知が一度も来ない」だけになる。
    if ((notifyCompletion || notifyReviewStatus) && typeof store.getPullRequest !== "function") {
      throw new TypeError("PR notices require a state store that can read pull requests.");
    }
    this.store = store;
    this.afterCompleted = afterCompleted;
    this.notifyCompletion = notifyCompletion;
    this.notifyReviewStatus = notifyReviewStatus;
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

  async #announceReviewStatus(event, localPrId) {
    const pullRequest = this.store.getPullRequest(localPrId);
    if (pullRequest && typeof this.store.appendPullRequestEvent === "function") {
      this.store.appendPullRequestEvent(localPrId, {
        event,
        message: pullRequestLifecycleMessage(event, pullRequest),
        tone: pullRequestLifecycleTone(event),
      });
    }
    if (!this.notifyReviewStatus) return;
    try {
      if (pullRequest) await this.notifyReviewStatus(event, pullRequest);
    } catch {
      // Discord status is best-effort and must not change the review verdict.
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
      intentReviewCompleted: job.result?.intentReviewCompleted === true,
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
      geniusGuidance: job.result?.geniusGuidance ?? null,
    });
    // 審査結果とマージは別イベント。自動マージより先に Test OK / 失敗を知らせる。
    await this.#announceReviewStatus(
      passed ? "review_passed" : "review_failed",
      job.request.localPrId,
    );
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
    await this.#announceReviewStatus("review_failed", job.request.localPrId);
    // 失敗も終局状態。ここで黙ると投稿側は running のまま待ち続ける。
    await this.#announce(job.request.localPrId);
  }
}
