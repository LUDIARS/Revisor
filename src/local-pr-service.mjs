import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { autoMergeDecision, autoMergeRecord } from "./auto-merge.mjs";
import { readSettings } from "./config.mjs";
import { installPushGuard } from "./push-guard.mjs";
import { pendingReviewProjection } from "./local-reporter.mjs";
import { squashMergeLocalPullRequest } from "./local-merge.mjs";
import { decidePullRequest, decidePullRequests } from "./pr-disposition.mjs";
import { inspectLocalPullRequest, git } from "./workspace.mjs";

const CLI_PATH = fileURLToPath(new URL("./cli.mjs", import.meta.url));

function reviewRequest(repository, pullRequest) {
  return {
    localPrId: pullRequest.id,
    repository: repository.repository,
    number: pullRequest.number,
    headSha: pullRequest.headSha,
    headRef: pullRequest.headRef,
    headRepository: repository.repository,
    baseRef: pullRequest.baseRef,
    baseSha: pullRequest.baseSha,
    rootPath: repository.rootPath,
    testCases: repository.testCases,
    reviewMode: "full",
  };
}

export class LocalPrService {
  constructor({
    store,
    queue,
    installGuard = installPushGuard,
    merge = squashMergeLocalPullRequest,
    securityScan,
    cliPath = CLI_PATH,
    env = process.env,
    loadSettings = () => readSettings(env),
    notifyLifecycle = null,
  }) {
    if (!store || !queue) {
      throw new TypeError("Local PR service requires a state store and review queue.");
    }
    if (notifyLifecycle !== null && typeof notifyLifecycle !== "function") {
      throw new TypeError("Local PR lifecycle notifier must be a function.");
    }
    this.store = store;
    this.queue = queue;
    this.installGuard = installGuard;
    this.merge = merge;
    this.securityScan = securityScan;
    this.env = env;
    this.cliPath = cliPath;
    this.notifyLifecycle = notifyLifecycle;
    // Read on every decision, not cached: moving the accepted risk threshold has
    // to re-colour and re-sort the dashboard without restarting the service.
    this.loadSettings = loadSettings;
  }

  async registerRepository(registration) {
    await access(registration.rootPath);
    const topLevel = await git(registration.rootPath, ["rev-parse", "--show-toplevel"]);
    if (
      topLevel.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
      !== registration.rootPath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
    ) {
      throw new Error("root_path must be the root of a Git working tree.");
    }
    await git(registration.rootPath, [
      "rev-parse",
      "--verify",
      `refs/heads/${registration.baseRef}`,
    ]);
    const hookPath = await this.installGuard({
      repoPath: registration.rootPath,
      cliPath: this.cliPath,
      statePath: this.store.path,
    });
    return this.store.registerRepository({ ...registration, hookPath });
  }

  listRepositories() {
    return this.store.listRepositories();
  }

  async submitPullRequest(submission) {
    const repository = this.store.getRepository(submission.repository);
    if (!repository) {
      throw new Error(`Repository '${submission.repository}' is not registered.`);
    }
    const baseRef = submission.baseRef ?? repository.baseRef;
    if (baseRef !== repository.baseRef) {
      throw new Error(
        `Local PR base_ref must match the registered base '${repository.baseRef}'.`,
      );
    }
    const refs = await inspectLocalPullRequest(
      repository.rootPath,
      submission.headRef,
      baseRef,
    );
    const existing = this.store.findExactPullRequest(
      repository.repository,
      refs.headSha,
    );
    if (existing) {
      // 同一 head の再投稿は既存レビューに相乗りする。 その既存 PR がまだ終局して
      // いないのに宛先を持たないと (CLI 投稿の後にセッションが投げ直した等)、
      // 投げ直した側は永久に来ない完了通知を待つことになるので、ここで宛先を
      // 引き継ぐ。 既に宛先がある場合は奪わない (通知は 1 レビュー 1 通)。
      const inFlight = existing.checkStatus === "queued" || existing.checkStatus === "running";
      if (inFlight && submission.sessionId && !existing.sessionId) {
        return this.store.updatePullRequest(existing.id, {
          sessionId: submission.sessionId,
        });
      }
      return existing;
    }
    const pullRequest = this.store.createPullRequest({
      repository: repository.repository,
      title: submission.title,
      body: submission.body,
      author: submission.author,
      draft: submission.draft === true,
      labels: submission.labels ?? [],
      assignees: submission.assignees ?? [],
      reviewers: submission.reviewers ?? [],
      headRef: submission.headRef,
      baseRef,
      headSha: refs.headSha,
      baseSha: refs.baseSha,
      sessionId: submission.sessionId ?? null,
    });
    await this.#announceLifecycle("created", pullRequest);
    return this.#enqueue(repository, pullRequest);
  }

  async retryPullRequest(id) {
    const pullRequest = this.store.getPullRequest(id);
    if (!pullRequest) throw new Error(`Local PR '${id}' was not found.`);
    if (pullRequest.status !== "open") {
      throw new Error("Only an open local PR can be reviewed again.");
    }
    return this.#requeue(pullRequest);
  }

  /**
   * プロセス再起動で失われたレビューを拾い直す。
   *
   * キューは in-memory なので、起動直後に `queued` / `running` が残っている PR は
   * 定義上どのワーカーにも属していない (= 実行中の job は存在しない)。 時間しきい値は
   * 不要で、この 2 状態がそのまま「中断された」ことの証明になる。 復旧しないと
   * `queue.submit` の再投入ガード (`queued` / `running` は force 無しで弾く) により
   * 永久に動かないゾンビとして残り続ける。
   *
   * 1 件の失敗で起動全体を落とさない。 復旧できない PR は理由付きで `failed` にして、
   * 人間が retry / 取り下げを判断できる状態にする。
   */
  async recoverInterruptedReviews() {
    const interrupted = this.store.listPullRequests().filter((pullRequest) =>
      pullRequest.status === "open"
      && (pullRequest.checkStatus === "running" || pullRequest.checkStatus === "queued"));

    const recovered = [];
    const failed = [];
    for (const pullRequest of interrupted) {
      try {
        // 復旧失敗の通知はここが唯一の担当。 #enqueue に送らせると、直後に上書き
        // する enqueue 側の理由で 1 通出てから復旧理由でもう 1 通出てしまう。
        await this.#requeue(pullRequest, { announceFailure: false });
        recovered.push({ id: pullRequest.id, repository: pullRequest.repository, number: pullRequest.number });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // #requeue が enqueue 前に落ちた場合 (repo 未登録 / ブランチ消失) は
        // まだ `running` のままなので、ここで必ず終端状態へ落とす。
        const record = this.store.updatePullRequest(pullRequest.id, {
          checkStatus: "failed",
          error: `Revisor restarted while this review was in flight and it could not be resumed: ${reason}`,
        });
        await this.#announceLifecycle("review_failed", record);
        failed.push({ id: pullRequest.id, repository: pullRequest.repository, number: pullRequest.number, reason });
      }
    }
    return { scanned: interrupted.length, recovered, failed };
  }

  async #requeue(pullRequest, { announceFailure = true } = {}) {
    const repository = this.store.getRepository(pullRequest.repository);
    if (!repository) {
      throw new Error(`Repository '${pullRequest.repository}' is not registered.`);
    }
    // The branch may have moved since the failed run, so re-resolve both refs.
    const refs = await inspectLocalPullRequest(
      repository.rootPath,
      pullRequest.headRef,
      pullRequest.baseRef,
    );
    return this.#enqueue(
      repository,
      this.store.updatePullRequest(pullRequest.id, {
        ...pendingReviewProjection(),
        headSha: refs.headSha,
        baseSha: refs.baseSha,
        checkStatus: "queued",
        error: null,
      }),
      // The refs may be unchanged, and the queue caches settled jobs by exact
      // head, so an unforced re-review would resolve to the run being retried.
      { force: true },
      { announceFailure },
    );
  }

  async #enqueue(repository, pullRequest, options, { announceFailure = true } = {}) {
    try {
      await this.queue.submit(reviewRequest(repository, pullRequest), options);
    } catch (error) {
      const failed = this.store.updatePullRequest(pullRequest.id, {
        checkStatus: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      if (announceFailure) await this.#announceLifecycle("review_failed", failed);
      throw error;
    }
    return this.store.getPullRequest(pullRequest.id);
  }

  async #announceLifecycle(event, pullRequest) {
    if (!this.notifyLifecycle) return;
    try {
      await this.notifyLifecycle(event, pullRequest);
    } catch {
      // Discord status is observability only; it must not change PR admission.
    }
  }

  getPullRequest(id) {
    const pullRequest = this.store.getPullRequest(id);
    return pullRequest ? decidePullRequest(pullRequest, this.loadSettings()) : null;
  }

  // Ordered so the pull requests that need a human decision come first. Everything
  // else is a queue that hides the one row a person actually has to look at.
  listPullRequests() {
    return decidePullRequests(this.store.listPullRequests(), this.loadSettings());
  }

  testWorkflowProducts() {
    return this.store.testWorkflowProducts();
  }

  async mergePullRequest(id) {
    const pullRequest = this.store.getPullRequest(id);
    if (!pullRequest) throw new Error(`Local PR '${id}' was not found.`);
    const repository = this.store.getRepository(pullRequest.repository);
    if (!repository) {
      throw new Error(`Repository '${pullRequest.repository}' is not registered.`);
    }
    const mergeCommitSha = await this.merge({
      repository,
      pullRequest,
      env: this.env,
      ...(this.securityScan ? { scan: this.securityScan } : {}),
    });
    const merged = this.store.updatePullRequest(id, {
      status: "merged",
      checkStatus: "test_ok",
      mergeCommitSha,
      mergedAt: new Date().toISOString(),
    });
    await this.#announceLifecycle("merged", merged);
    return merged;
  }

  // Called once per completed review. The outcome is always recorded, including a
  // refusal, so the dashboard can say why a PR the human expected to disappear is
  // still waiting.
  async autoMergeIfEligible(id) {
    const pullRequest = this.store.getPullRequest(id);
    if (!pullRequest) return null;
    const settings = this.loadSettings();
    const decision = autoMergeDecision(pullRequest, settings);
    if (!decision.merge) {
      if (!settings.autoMergeEnabled) return pullRequest;
      return this.store.updatePullRequest(id, {
        autoMerge: autoMergeRecord({ merged: false, reason: decision.reason }),
      });
    }
    try {
      await this.mergePullRequest(id);
      return this.store.updatePullRequest(id, {
        autoMerge: autoMergeRecord({ merged: true, reason: decision.reason }),
      });
    } catch (error) {
      return this.store.updatePullRequest(id, {
        autoMerge: autoMergeRecord({
          merged: false,
          reason: `自動マージに失敗しました: ${
            error instanceof Error ? error.message : String(error)
          }`,
        }),
      });
    }
  }
}
