import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { autoMergeDecision, autoMergeRecord } from "./auto-merge.mjs";
import { readSettings } from "./config.mjs";
import { MergeConflictError, StaleReviewError } from "./errors.mjs";
import { withFileLock, withFileLockSync } from "./file-lock.mjs";
import { installPushGuard } from "./push-guard.mjs";
import { pendingReviewProjection } from "./local-reporter.mjs";
import {
  pullRequestLifecycleMessage,
  pullRequestLifecycleTone,
} from "./pr-lifecycle-notice.mjs";
import { squashMergeLocalPullRequest } from "./local-merge.mjs";
import { mergeFailureMessage, writeMergeFailureLog } from "./merge-failure-log.mjs";
import { prepareMergeRepository } from "./merge-repository.mjs";
import {
  approvedPullRequestForManualMerge,
  canBypassPreMergeSystemFailure,
  isHumanOverrideableReviewHold,
} from "./human-decision.mjs";
import { decidePullRequest, decidePullRequests } from "./pr-disposition.mjs";
import { PublicationCoordinator } from "./publication-coordinator.mjs";
import { inspectLocalPullRequest, git } from "./workspace.mjs";
import { retryReviewScope } from "./retry-review.mjs";
import { appendSourceLinks } from "./source-links.mjs";
import {
  assertLocalVersionUnchanged,
  prepareRegisteredVersionFile,
} from "./local-version.mjs";

const CLI_PATH = fileURLToPath(new URL("./cli.mjs", import.meta.url));

// 同じヘッドに対して自動再審査を許す回数。 1 回目は「審査中にヘッドが動いた」等の
// 正当な取りこぼしを拾うため必要で、それを超えて同じ判定が返るなら再審査では解けない。
const STALE_REQUEUE_LIMIT = 2;

function reviewRequest(repository, pullRequest, options = {}) {
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
    reviewMode: options.reviewMode ?? "full",
    verificationTargets: options.verificationTargets ?? [],
    previousReview: options.previousReview ?? null,
  };
}

function validationModeSkips(settings) {
  return [
    ...(settings.costValidationSkipReview ? ["reviewer_autofix"] : []),
    ...(settings.costValidationSkipGenius ? ["genius_judgment"] : []),
    ...(settings.costValidationSkipAnatomiaDomain ? ["anatomia_domain_review"] : []),
  ].sort();
}

function sameValidationMode(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export class LocalPrService {
  constructor({
    store,
    queue,
    installGuard = installPushGuard,
    merge = squashMergeLocalPullRequest,
    prepareMerge = prepareMergeRepository,
    logMergeFailure = writeMergeFailureLog,
    securityScan,
    publisher,
    prepareVersionFile = prepareRegisteredVersionFile,
    cliPath = CLI_PATH,
    env = process.env,
    loadSettings = () => readSettings(env),
    notifyLifecycle = null,
    publicationCoordinator = new PublicationCoordinator(),
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
    this.prepareMerge = prepareMerge;
    this.logMergeFailure = logMergeFailure;
    this.securityScan = securityScan;
    this.publisher = publisher;
    this.prepareVersionFile = prepareVersionFile;
    this.env = env;
    this.cliPath = cliPath;
    this.notifyLifecycle = notifyLifecycle;
    this.publicationCoordinator = publicationCoordinator;
    this.lifecycleLockPath = store.path ? `${store.path}.lifecycle` : null;
    // Read on every decision, not cached: moving the accepted risk threshold has
    // to re-colour and re-sort the dashboard without restarting the service.
    this.loadSettings = loadSettings;
  }

  // 1 周の所要時間はマージ前セキュリティスキャン次第で interval を超える。 前周が
  // まだ走っているうちに次を重ねると、同じ候補を二重に処理しにいく。
  #sweeping = false;

  // squash の最中にある PR の id。 マージは数分かかる (マージ前セキュリティスキャン)
  // 一方 closePullRequest は同期で status を書くので、 走っているマージが完了時に
  // status: "merged" を書き戻して取り下げを踏み潰す — 取り下げたはずの変更が board に
  // 出ないまま main へ入る。 審査中の close を拒否するのとまったく同じ理由。
  #merging = new Set();

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
    await this.prepareVersionFile(registration.rootPath);
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

  getRepository(repository) {
    return this.store.getRepository(repository);
  }

  /** @implements SPEC-DAEMONLESS-PERSISTENT-QUEUE */
  async #reuseSubmittedPullRequest(existing, submission, repository) {
    // 同一 head の再投稿は既存レビューに相乗りする。 その既存 PR がまだ終局して
    // いないのに宛先を持たないと (CLI 投稿の後にセッションが投げ直した等)、
    // 投げ直した側は永久に来ない完了通知を待つことになるので、ここで宛先を
    // 引き継ぐ。 既に宛先がある場合は奪わない (通知は 1 レビュー 1 通)。
    const submissionPatch = (current) => {
      const inFlight = current.checkStatus === "queued" || current.checkStatus === "running";
      if (!inFlight) return null;
      const patch = {};
      if (submission.sessionId && !current.sessionId) patch.sessionId = submission.sessionId;
      const knownSourceUrls = new Set(
        (current.sourceLinks ?? []).map((link) => link.url),
      );
      const newSourceLinks = (submission.sourceLinks ?? []).filter((link) =>
        !knownSourceUrls.has(link.url));
      if (newSourceLinks.length > 0) {
        patch.sourceLinks = [...(current.sourceLinks ?? []), ...newSourceLinks];
        patch.body = appendSourceLinks(current.body, newSourceLinks);
      }
      return patch;
    };
    let reused;
    if (typeof this.store.updatePullRequestWith === "function") {
      reused = this.store.updatePullRequestWith(existing.id, submissionPatch);
    } else {
      const patch = submissionPatch(existing);
      reused = patch && Object.keys(patch).length > 0
        ? this.store.updatePullRequest(existing.id, patch)
        : existing;
    }
    // state 作成後・jobId 記録前に提出プロセスが落ちても、再投稿で queue を補修する。
    // enqueue は同じ (repo, number, head) を再利用するので、既存 job があっても二重実行しない。
    const inFlight = reused.checkStatus === "queued" || reused.checkStatus === "running";
    return inFlight && !reused.jobId ? this.#enqueue(repository, reused) : reused;
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
    await assertLocalVersionUnchanged(repository.rootPath, refs.baseSha, refs.headSha);
    const existing = this.store.findExactPullRequest(
      repository.repository,
      refs.headSha,
    );
    if (existing) return this.#reuseSubmittedPullRequest(existing, submission, repository);
    const candidate = {
      repository: repository.repository,
      title: submission.title,
      body: appendSourceLinks(submission.body, submission.sourceLinks),
      sourceLinks: submission.sourceLinks ?? [],
      author: submission.author,
      draft: false,
      labels: submission.labels ?? [],
      assignees: submission.assignees ?? [],
      reviewers: submission.reviewers ?? [],
      headRef: submission.headRef,
      baseRef,
      headSha: refs.headSha,
      baseSha: refs.baseSha,
      sessionId: submission.sessionId ?? null,
    };
    const creation = typeof this.store.createPullRequestIfAbsent === "function"
      ? this.store.createPullRequestIfAbsent(candidate)
      : { pullRequest: this.store.createPullRequest(candidate), created: true };
    if (!creation.created) {
      return this.#reuseSubmittedPullRequest(creation.pullRequest, submission, repository);
    }
    const pullRequest = creation.pullRequest;
    await this.#announceLifecycle("created", pullRequest);
    return this.#enqueue(repository, pullRequest);
  }

  async retryPullRequest(id) {
    const pullRequest = this.store.getPullRequest(id);
    if (!pullRequest) throw new Error(`Local PR '${id}' was not found.`);
    if (pullRequest.status !== "open") {
      throw new Error("Only an open local PR can be reviewed again.");
    }
    const queued = await this.#requeue(pullRequest);
    await this.#announceLifecycle("review_queued", queued);
    return queued;
  }

  /**
   * 取り下げる。 マージせずに終わる PR (別経路で main へ入った / 案を破棄した) を
   * 終局させ、 board と test workflow から外す。
   *
   * 審査中とマージ中は拒否する。 どちらも走っている処理が完了時に自分の結果を
   * 書き戻すので、 先に closed にしても上書きされる — 審査なら open へ戻ったように
   * 見えるだけ、 マージなら取り下げたはずの変更がそのまま main へ入る。
   * 理由は必須にしない代わりに、 渡されたものは記録して後から辿れるようにする。
   */
  async closePullRequest(id, { reason = null } = {}) {
    // 同一プロセスの async merge が lock を持っているとき同期 wait すると、merge の
    // 継続自体を event loop ごと止める。既存の in-memory guard で即座に拒否する。
    if (this.#merging.has(id)) {
      throw new Error("A local PR being merged cannot be closed; wait for the merge to finish.");
    }
    const close = () => {
      const pullRequest = this.store.getPullRequest(id);
      if (!pullRequest) throw new Error(`Local PR '${id}' was not found.`);
      if (pullRequest.status !== "open") {
        throw new Error(`Only an open local PR can be closed (it is '${pullRequest.status}').`);
      }
      if (pullRequest.checkStatus === "queued" || pullRequest.checkStatus === "running") {
        throw new Error("A local PR under review cannot be closed; wait for the review to finish.");
      }
      return this.store.updatePullRequest(id, {
        status: "closed",
        closedAt: new Date().toISOString(),
        closeReason: typeof reason === "string" && reason.trim() ? reason.trim() : null,
      });
    };
    const closed = this.lifecycleLockPath
      ? withFileLockSync(this.lifecycleLockPath, close, { label: "close-pull-request" })
      : close();
    await this.#announceLifecycle("closed", closed);
    return closed;
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

  /**
   * 同一ヘッドに対する自動再審査の回数を数え、上限内なら 1 回分を確保する。
   *
   * ヘッドが動いた再審査は正当な作業 (autofix コミット等) なので数え直す。
   * 数えるのは「同じヘッドのまま stale が返り続ける」場合だけ。
   */
  #admitStaleRequeue(id, headSha) {
    const key = headSha ? String(headSha).toLowerCase() : "unknown";
    const record = this.store.getPullRequest(id);
    const previous = record?.staleReviewRequeue ?? null;
    const count = previous && previous.headSha === key ? previous.count : 0;
    if (count >= STALE_REQUEUE_LIMIT) return false;
    this.store.updatePullRequest(id, {
      staleReviewRequeue: { headSha: key, count: count + 1 },
    });
    return true;
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
    await assertLocalVersionUnchanged(repository.rootPath, refs.baseSha, refs.headSha);
    let scope = retryReviewScope(pullRequest, refs.headSha);
    const previousValidationMode = [...(pullRequest.reviewPlan?.validationMode?.skipped ?? [])].sort();
    const currentValidationMode = pullRequest.reviewPlan
      ? validationModeSkips(this.loadSettings())
      : [];
    if (pullRequest.reviewPlan && !sameValidationMode(previousValidationMode, currentValidationMode)) {
      scope = { reviewMode: "full", verificationTargets: [] };
    }
    const previousReview = scope.reviewMode === "verification" ? pullRequest : null;
    return this.#enqueue(
      repository,
      this.store.updatePullRequest(pullRequest.id, {
        ...pendingReviewProjection(),
        headSha: refs.headSha,
        baseSha: refs.baseSha,
        checkStatus: "queued",
        error: null,
        // A publication failure is a blocker until it is superseded. A fresh
        // review is that supersession, so keeping the old merge error would
        // leave the re-approved PR permanently un-mergeable on the board.
        mergeError: null,
      }),
      // The refs may be unchanged, and the queue caches settled jobs by exact
      // head, so an unforced re-review would resolve to the run being retried.
      { force: true },
      { announceFailure, requestOptions: { ...scope, previousReview } },
    );
  }

  async #enqueue(repository, pullRequest, options, {
    announceFailure = true,
    requestOptions = {},
  } = {}) {
    try {
      await this.queue.submit(reviewRequest(repository, pullRequest, requestOptions), options);
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
    if (typeof this.store.appendPullRequestEvent === "function") {
      this.store.appendPullRequestEvent(pullRequest.id, {
        event,
        message: pullRequestLifecycleMessage(event, pullRequest),
        tone: pullRequestLifecycleTone(event),
      });
    }
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

  // Board order is derived from current mergeability and creation time. Keeping
  // it at read time makes a just-approved PR move immediately without rewriting
  // stored records.
  listPullRequests() {
    return decidePullRequests(this.store.listPullRequests(), this.loadSettings());
  }

  testWorkflowProducts() {
    return this.store.testWorkflowProducts();
  }

  // squash マージは base ref を前進させる。定期スイープ・レビュー完了時の自動マージ・
  // UI からの手動マージ・Releases タブの即時公開を publicationCoordinator が直列化し、
  // 同じ baseSha / version を同時に選ばせない。
  // `humanApproved` はボードの明示操作かどうか。 既定を true にしているのは、
  // 呼び出し元が HTTP の merge エンドポイント (token / セッション必須) だから。
  // 自動マージ経路だけが false を渡し、 Genius の判断保留を勝手に解けなくする。
  /**
   * `bypass` は CLI 限定のバイパスマージ。 Revisor / Concordia 自身が落ちて審査を回せない
   * ときに、まず動作を取り戻すための最小経路で、理由の記録を必須にしている
   * (復旧後に後追いレビューする対象を、記録から必ず特定できるようにするため)。
   * HTTP 経路はこの引数を渡さない。
   */
  async mergePullRequest(id, { humanApproved = true, bypass = null } = {}) {
    if (bypass && !String(bypass.reason ?? "").trim()) {
      throw new Error("A bypass merge requires a reason.");
    }
    return this.publicationCoordinator.run(() => this.lifecycleLockPath
      ? withFileLock(
        this.lifecycleLockPath,
        () => this.#mergeOnce(id, humanApproved, bypass),
        { label: "merge-pull-request" },
      )
      : this.#mergeOnce(id, humanApproved, bypass));
  }

  async #mergeOnce(id, humanApproved, bypass = null) {
    const pullRequest = this.store.getPullRequest(id);
    if (!pullRequest) throw new Error(`Local PR '${id}' was not found.`);
    // 終局済み (merged / closed) を再びマージしない。 closed を通すと、 取り下げた
    // 変更が board に出ないまま main へ入る。
    if (pullRequest.status !== "open") {
      throw new Error(`Only an open local PR can be merged (it is '${pullRequest.status}').`);
    }
    const repository = this.store.getRepository(pullRequest.repository);
    if (!repository) {
      throw new Error(`Repository '${pullRequest.repository}' is not registered.`);
    }
    // 取り下げを締め出す区間は、 squash を始めてから status を書き終えるまで。
    // base ref が動いたあとに close が通ると、 main へ入った変更が closed として
    // board から消え、 記録と Git が食い違う。
    this.#merging.add(id);
    let mergeRootPath = null;
    try {
      // The merge endpoint is the board's explicit human action. Genius reviews
      // stay action_required for auto-merge, but the sole card-confirmation hold
      // may be acknowledged here without weakening any other blocker.
      const approvedPullRequest = humanApproved
        ? approvedPullRequestForManualMerge(pullRequest)
        : pullRequest;
      const allowSystemFailureOverride = humanApproved
        && (isHumanOverrideableReviewHold(pullRequest)
          || canBypassPreMergeSystemFailure(pullRequest));
      const mergeRepository = await this.prepareMerge({
        repository,
        pullRequest: approvedPullRequest,
        statePath: this.store.path,
      });
      mergeRootPath = mergeRepository.rootPath;
      const publication = await this.merge({
        repository: mergeRepository,
        pullRequest: approvedPullRequest,
        env: this.env,
        allowSystemFailureOverride,
        ...(bypass ? { bypass } : {}),
        ...(this.securityScan ? { scan: this.securityScan } : {}),
        ...(this.publisher ? { publish: this.publisher } : {}),
      });
      const mergeCommitSha = typeof publication === "string"
        ? publication
        : publication.mergeCommitSha;
      const merged = this.store.updatePullRequest(id, {
        status: "merged",
        checkStatus: "test_ok",
        reasons: [],
        mergeCommitSha,
        mergeError: null,
        releaseTag: typeof publication === "object" ? publication.releaseTag ?? null : null,
        releaseUrl: typeof publication === "object" ? publication.releaseUrl ?? null : null,
        publishedAt: new Date().toISOString(),
        mergedAt: new Date().toISOString(),
        // 審査を通さずに入った変更は、記録の上で通常のマージと区別できなければならない。
        // 後追いレビューの対象一覧はこの印から作る。
        ...(bypass
          ? {
            bypassMerge: {
              reason: String(bypass.reason).trim(),
              actor: bypass.actor ?? "cli",
              checkStatusAtMerge: pullRequest.checkStatus,
              reviewedHeadSha: pullRequest.reviewedHeadSha ?? null,
              at: new Date().toISOString(),
              reviewedAfterRecovery: false,
            },
          }
          : {}),
      });
      await this.#announceLifecycle(bypass ? "bypass_merged" : "merged", merged);
      return merged;
    } catch (error) {
      try {
        this.logMergeFailure({
          error,
          repository,
          pullRequest,
          mergeRootPath,
        });
      } catch {
        // Observability failure must not replace the merge failure returned to
        // the caller or prevent its safe, redacted board projection.
      }
      // コンフリクトは再審査では直らない: ブランチ側の rebase が要るので、 Test OK
      // から外して人間の判断待ちに落とす (Test Forum からも消える)。
      if (error instanceof MergeConflictError) {
        this.store.updatePullRequest(id, {
          checkStatus: "action_required",
          reasons: [error.message],
        });
        throw error;
      }
      // 審査後に差分内容が変わったヘッドは、新しい内容をそのまま再審査に回す。
      // ただし同じヘッドで何度も stale 判定が返るのは、再審査では解けない事態
      // (審査済み SHA の消失など) が起きている証拠なので、そこで自動再投入を打ち切って
      // 人間の判断へ渡す。 60 秒周期のスイープが同じ再審査を無限に積み続けるのを防ぐ。
      if (error instanceof StaleReviewError) {
        // Built-in merge checks attach the resolved current head to the error.
        // Keep injected or legacy merge implementations on the same per-head
        // policy: they may still throw the older, message-only error shape.
        // `pullRequest` is the record admitted to this merge attempt, so it is
        // the safe fallback rather than sharing a global "unknown" counter.
        if (!this.#admitStaleRequeue(id, error.headSha ?? pullRequest.headSha)) {
          const held = this.store.updatePullRequest(id, {
            checkStatus: "action_required",
            reasons: [
              `${error.message} 同じヘッドで再審査を ${STALE_REQUEUE_LIMIT} 回試しても解消しないため、`
              + "自動再審査を停止しました。",
            ],
          });
          await this.#announceLifecycle("review_failed", held);
          throw error;
        }
        await this.#requeue(pullRequest);
        throw error;
      }
      // A publication failure carries Git and GitHub API text straight onto the
      // decision board and into notifications, so it obeys the same boundary as
      // any other stored free-form output: locations survive, secrets do not.
      this.store.updatePullRequest(id, {
        mergeError: mergeFailureMessage(error),
      });
      throw error;
    } finally {
      this.#merging.delete(id);
    }
  }

  // レビュー完了直後の 1 回だけでは「その時点で base が古かった」PR が永久に残る。
  // base が進んでも squash が通るようになった PR を拾う定期スイープ。 見送りは
  // 記録しない (毎周期 autoMerge 記録を書き換えると updatedAt が無意味に churn する)。
  async sweepAutoMerge() {
    const summary = { attempted: 0, merged: 0, failed: 0 };
    if (this.#sweeping) return summary;
    this.#sweeping = true;
    try {
      const settings = this.loadSettings();
      if (!settings.autoMergeEnabled) return summary;
      const candidates = this.store.listPullRequests().filter((pullRequest) =>
        pullRequest.status === "open"
        && pullRequest.checkStatus === "test_ok");
      for (const candidate of candidates) {
        // 1 件マージするたびに base は進み、レビュー完了や手動マージも並行して状態を
        // 動かす。 候補一覧は周回の開始時点のスナップショットなので、判定は必ず最新の
        // 記録で取り直す (でないと既にマージ済みの PR を再度マージしにいく)。
        const pullRequest = this.store.getPullRequest(candidate.id);
        if (
          !pullRequest
          || pullRequest.status !== "open"
          || pullRequest.checkStatus !== "test_ok"
        ) continue;
        const decision = autoMergeDecision(pullRequest, settings);
        if (!decision.merge) continue;
        summary.attempted += 1;
        try {
          await this.mergePullRequest(pullRequest.id, { humanApproved: false });
          this.store.updatePullRequest(pullRequest.id, {
            autoMerge: autoMergeRecord({ merged: true, reason: decision.reason }),
          });
          summary.merged += 1;
        } catch (error) {
          summary.failed += 1;
          // mergePullRequest 側で action_required / 再審査へ落ちた PR はその状態が
          // 既に理由を語っている。 それ以外の失敗だけ autoMerge 記録に残す。
          if (!(error instanceof MergeConflictError) && !(error instanceof StaleReviewError)) {
            this.store.updatePullRequest(pullRequest.id, {
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
      return summary;
    } finally {
      this.#sweeping = false;
    }
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
      await this.mergePullRequest(id, { humanApproved: false });
      return this.store.updatePullRequest(id, {
        autoMerge: autoMergeRecord({ merged: true, reason: decision.reason }),
      });
    } catch (error) {
      // スイープと同じ扱い: コンフリクト (action_required) と再審査行き (queued) は
      // mergePullRequest が既に状態で理由を語っている。 ここで記録を重ねると、
      // 再審査待ちの PR に古い失敗理由が貼りつく。
      if (error instanceof MergeConflictError || error instanceof StaleReviewError) {
        return this.store.getPullRequest(id);
      }
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
