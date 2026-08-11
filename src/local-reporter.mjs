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
    baselineComplexityFunctionCount: result.baselineComplexityFunctionCount,
    complexityScoreDelta: result.complexityScoreDelta,
    source: result.analysisSource,
  };
}

function anatomiaGateProjection(result) {
  const gate = result?.anatomiaGate;
  if (!gate) return null;
  // The runner needs the CLI path and raw analysis internally, but the local PR
  // is durable and exposed through the UI API. Persist only the verdict fields
  // so workstation paths and proprietary analysis artifacts cannot leak there.
  return {
    status: gate.status,
    message: gate.message,
    reasons: Array.isArray(gate.reasons) ? gate.reasons : [],
  };
}

function anatomiaGateTone(status) {
  if (status === "blocked") return "error";
  if (status === "passed") return "ok";
  return "idle";
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
    anatomiaGate: null,
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
    // 現役 job 判定 (`#isCurrent`) も通知も、PR レコードを読めることが前提。
    // 読めない store を黙って受け取ると、supersession ガードが素通りして
    // 古い job が現在の審査結果を上書きする経路が復活する。
    if (
      !store
      || typeof store.updatePullRequest !== "function"
      || typeof store.getPullRequest !== "function"
    ) {
      throw new TypeError("Local PR reporter requires a readable and writable state store.");
    }
    if (notifyReviewStatus !== null && typeof notifyReviewStatus !== "function") {
      throw new TypeError("Review status notifier must be a function.");
    }
    this.store = store;
    this.afterCompleted = afterCompleted;
    this.notifyCompletion = notifyCompletion;
    this.notifyReviewStatus = notifyReviewStatus;
  }

  /**
   * この job が今もその PR の現役 job かを判定する。
   *
   * retry / 再投入は同じ localPrId に別 job を作るので、古い job の
   * `running` / `completed` / `failed` をそのまま書くと、新しい審査の状態を
   * 古いヘッドの結果で上書きしてしまう。 これは 60 秒周期の auto-merge sweep と
   * 噛み合うと終わらない: sweep が stale な test_ok をマージしようとして
   * `StaleReviewError` → 再投入 → 古い job が再び古い結果で test_ok を復元 →
   * 次の sweep がまた同じ判定、という無限再投入になる。
   *
   * 所有権は `queued` が書く `jobId` が正本。 ヘッド SHA も併せて見るのは、
   * job が別でも同一ヘッドを指す再投入と、ヘッドが動いた再投入を区別するため。
   */
  #isCurrent(job) {
    const pullRequest = this.store.getPullRequest(job.request.localPrId);
    if (!pullRequest) return false;
    if (pullRequest.jobId !== job.id) return false;
    return String(pullRequest.headSha).toLowerCase()
      === String(job.request.headSha).toLowerCase();
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
      reviewLane: job.request.reviewLane ?? "standard",
    });
  }

  async running(job) {
    if (!this.#isCurrent(job)) return;
    this.store.updatePullRequest(job.request.localPrId, {
      checkStatus: "running",
    });
  }

  /**
   * Checkpoint written the moment the intent review succeeds, ahead of the
   * remaining stages. `checkStatus` deliberately stays `running`: the review is
   * not finished, only the part that cannot be repeated cheaply. If the process
   * dies after this point, `retryReviewScope` sees a completed intent review for
   * this head and resumes in verification mode instead of paying for the model
   * review again (spec/feature/crash-recovery.md).
   */
  async intentReviewCompleted({ localPrId, jobId, reviewedHeadSha, reviewer, plan }) {
    const pullRequest = this.store.getPullRequest(localPrId);
    if (
      !pullRequest
      || (jobId != null && pullRequest.jobId !== jobId)
      || String(pullRequest.headSha).toLowerCase() !== String(reviewedHeadSha).toLowerCase()
    ) {
      return;
    }
    this.store.updatePullRequest(localPrId, {
      intentReviewCompleted: true,
      reviewedHeadSha,
      reviewer: reviewer ?? null,
      reviewPlan: plan ?? null,
    });
  }

  async completed(job) {
    // 追い越された job の結果は診断用にキュー側の履歴へ残るだけで、PR の現在の
    // 判定にも通知にも反映しない。 自動マージも同様: 古いヘッドの test_ok で
    // マージを走らせない。
    if (!this.#isCurrent(job)) return;
    const passed = job.result?.conclusion === "success";
    this.store.updatePullRequest(job.request.localPrId, {
      checkStatus: passed ? "test_ok" : "action_required",
      reviewedHeadSha: job.result?.reviewedHeadSha ?? job.request.headSha,
      reviewer: job.result?.reviewer ?? null,
      intentReviewCompleted: job.result?.intentReviewCompleted === true,
      ci: job.result?.ci ?? [],
      anatomia: analysisProjection(job.result),
      anatomiaGate: anatomiaGateProjection(job.result),
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
    if (job.result?.anatomiaGate && typeof this.store.appendPullRequestEvent === "function") {
      this.store.appendPullRequestEvent(job.request.localPrId, {
        event: "anatomia_gate",
        message: job.result.anatomiaGate.message,
        tone: anatomiaGateTone(job.result.anatomiaGate.status),
      });
    }
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
    // 追い越された job の失敗で現在の審査を `failed` に落とすと、投稿元には
    // 古いヘッドの失敗通知が届き、board 上も進行中の審査が失敗に見える。
    if (!this.#isCurrent(job)) return;
    this.store.updatePullRequest(job.request.localPrId, {
      checkStatus: "failed",
      error: job.error || "The local review worker failed.",
    });
    await this.#announceReviewStatus("review_failed", job.request.localPrId);
    // 失敗も終局状態。ここで黙ると投稿側は running のまま待ち続ける。
    await this.#announce(job.request.localPrId);
  }
}
