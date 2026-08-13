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
import { syncSourceCheckout } from "./source-checkout-sync.mjs";
import { mergeFailureMessage, writeMergeFailureLog } from "./merge-failure-log.mjs";
import { prepareMergeRepository } from "./merge-repository.mjs";
import { probeBaseMergeability } from "./submit-probe.mjs";
import {
  approvedPullRequestForManualMerge,
  canBypassPreMergeSystemFailure,
  isHumanOverrideableReviewHold,
} from "./human-decision.mjs";
import { decidePullRequest, decidePullRequests } from "./pr-disposition.mjs";
import {
  isDeferredPublication,
  PUBLICATION_DEFERRED,
  PUBLICATION_PUBLISHED,
} from "./publication-state.mjs";
import { PublicationCoordinator } from "./publication-coordinator.mjs";
import { diffPatchId, inspectLocalPullRequest, git } from "./workspace.mjs";
import { retryReviewScope } from "./retry-review.mjs";
import { appendSourceLinks } from "./source-links.mjs";
import {
  assertLocalVersionUnchanged,
  prepareRegisteredVersionFile,
} from "./local-version.mjs";
import { normalizeReviewLane, REVIEW_LANES } from "./review-lane.mjs";
import { decisionSettingsKey, PrListCache } from "./pr-list-cache.mjs";

const CLI_PATH = fileURLToPath(new URL("./cli.mjs", import.meta.url));

// 同じヘッドに対して自動再審査を許す回数。 1 回目は「審査中にヘッドが動いた」等の
// 正当な取りこぼしを拾うため必要で、それを超えて同じ判定が返るなら再審査では解けない。
const STALE_REQUEUE_LIMIT = 2;

/**
 * `rootPath` は登録元 checkout (head の在処であり autofix の反映先)、
 * `reviewRootPath` は審査の差分起点となる base ref を持つ merge repository。
 * 登録元の base ref は追随前の古い位置に留まりうるので、 差分の起点にはしない
 * (`spec/feature/review-diff-scope.md`)。
 *
 * @implements SPEC-PR-NARRATIVE-RECONCILIATION
 */
function reviewRequest(repository, reviewRepository, pullRequest, options = {}) {
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
    reviewRootPath: reviewRepository.rootPath,
    testCases: repository.testCases,
    reviewMode: options.reviewMode ?? "full",
    verificationTargets: options.verificationTargets ?? [],
    previousReview: options.previousReview ?? null,
    pullRequest: {
      title: pullRequest.title,
      body: pullRequest.body,
      narrative: pullRequest.narrative ?? null,
    },
    reviewedContentUnchanged: options.reviewedContentUnchanged === true,
    reviewLane: normalizeReviewLane(pullRequest.reviewLane),
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
    jobs = null,
    installGuard = installPushGuard,
    merge = squashMergeLocalPullRequest,
    prepareMerge = prepareMergeRepository,
    probeMergeability = probeBaseMergeability,
    logMergeFailure = writeMergeFailureLog,
    syncCheckout = syncSourceCheckout,
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
    this.jobs = jobs ?? queue.jobs ?? null;
    this.installGuard = installGuard;
    this.merge = merge;
    this.prepareMerge = prepareMerge;
    this.probeMergeability = probeMergeability;
    this.logMergeFailure = logMergeFailure;
    this.syncCheckout = syncCheckout;
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
  #listCache = new PrListCache();

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
    const repaired = inFlight && !reused.jobId
      ? await this.#enqueue(repository, reused)
      : reused;
    if (
      submission.reviewLane === REVIEW_LANES.FAST
      && normalizeReviewLane(repaired.reviewLane) !== REVIEW_LANES.FAST
    ) {
      return this.promotePullRequest(repaired.id, { sessionId: submission.sessionId ?? null });
    }
    return repaired;
  }

  async submitPullRequest(submission) {
    if (submission.reviewLane === REVIEW_LANES.FAST) this.#assertFastLaneAvailable();
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
      reviewLane: normalizeReviewLane(submission.reviewLane),
    };
    const creation = typeof this.store.createPullRequestIfAbsent === "function"
      ? this.store.createPullRequestIfAbsent(candidate)
      : { pullRequest: this.store.createPullRequest(candidate), created: true };
    if (!creation.created) {
      return this.#reuseSubmittedPullRequest(creation.pullRequest, submission, repository);
    }
    const pullRequest = creation.pullRequest;
    await this.#announceLifecycle("created", pullRequest);
    // 載らない head を審査へ通すと、モデルレビューもテストも走らせた末に取り込みで
    // 落ちる。 判定は取り込みとまったく同じ手順で行い、 結果は捨てる (載せ替えの本番は
    // 取り込み時)。
    const probe = await this.#probeBaseMergeability(repository, pullRequest);
    if (probe?.status === "conflict") {
      return this.store.updatePullRequest(pullRequest.id, {
        checkStatus: "action_required",
        reasons: [probe.reason],
      });
    }
    return this.#enqueue(repository, pullRequest);
  }

  /**
   * 提出時の早期チェック。 判定できなかった場合は審査へ進める — 取り込み時に改めて
   * 判定されるので、 ここで止めると判定器の不調が提出そのものを塞いでしまう。
   */
  async #probeBaseMergeability(repository, pullRequest) {
    if (typeof this.probeMergeability !== "function") return null;
    try {
      const mergeRepository = await this.prepareMerge({
        repository,
        pullRequest,
        statePath: this.store.path,
      });
      return await this.probeMergeability({
        mergeRepository,
        baseRef: pullRequest.baseRef,
        headSha: pullRequest.headSha,
      });
    } catch {
      return null;
    }
  }

  async retryPullRequest(id, { fastLane = false } = {}) {
    const pullRequest = this.store.getPullRequest(id);
    if (!pullRequest) throw new Error(`Local PR '${id}' was not found.`);
    if (pullRequest.status !== "open") {
      throw new Error("Only an open local PR can be reviewed again.");
    }
    if (typeof fastLane !== "boolean") throw new Error("fast_lane must be a boolean.");
    if (fastLane) this.#assertFastLaneAvailable();
    const queued = await this.#requeue(pullRequest, {
      reviewLane: fastLane ? REVIEW_LANES.FAST : REVIEW_LANES.STANDARD,
    });
    await this.#announceLifecycle("review_queued", queued);
    return queued;
  }

  /** @implements SPEC-REVIEW-FAST-LANE-AUTHORITY */
  async promotePullRequest(id, { sessionId = null } = {}) {
    const pullRequest = this.store.getPullRequest(id);
    if (!pullRequest) throw new Error(`Local PR '${id}' was not found.`);
    if (pullRequest.status !== "open" || pullRequest.checkStatus !== "queued") {
      throw new Error("Only a queued open local PR can be moved to the fast lane.");
    }
    if (sessionId && pullRequest.sessionId && sessionId !== pullRequest.sessionId) {
      throw new Error("Only the submitting Concordia session can promote this local PR.");
    }
    if (normalizeReviewLane(pullRequest.reviewLane) === REVIEW_LANES.FAST) {
      return pullRequest;
    }
    this.#assertFastLaneAvailable();
    await this.queue.promote(id);
    return this.store.updatePullRequest(id, {
      reviewLane: REVIEW_LANES.FAST,
      fastLanePromotedAt: new Date().toISOString(),
      fastLaneRequestedBySessionId: sessionId,
    });
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
   * 永続ジョブが `queued` / `running` なら、その PR は既にキューまたはワーカーに属するため
   * 再投入してはいけない。反対に、実行中の job が無いこの 2 状態は「中断された」ことの
   * 証明になる。時間しきい値は不要で、復旧しないと
   * `queue.submit` の再投入ガード (`queued` / `running` は force 無しで弾く) により
   * 永久に動かないゾンビとして残り続ける。
   *
   * 1 件の失敗で起動全体を落とさない。 復旧できない PR は理由付きで `failed` にして、
   * 人間が retry / 取り下げを判断できる状態にする。
   */
  async recoverInterruptedReviews() {
    const interrupted = this.store.listPullRequests().filter((pullRequest) =>
      pullRequest.status === "open"
      && (pullRequest.checkStatus === "running" || pullRequest.checkStatus === "queued")
      && !this.#hasActiveReviewJob(pullRequest.id, { unknownIsActive: false }));

    const recovered = [];
    const failed = [];
    for (const pullRequest of interrupted) {
      try {
        // 復旧失敗の通知はここが唯一の担当。 #enqueue に送らせると、直後に上書き
        // する enqueue 側の理由で 1 通出てから復旧理由でもう 1 通出てしまう。
        await this.#requeue(pullRequest, {
          announceFailure: false,
          allowActiveSameHead: true,
        });
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
   * 審査済みヘッドと現在ヘッドが「同じ内容」か。
   *
   * base が動くたびに載せ替えが要る運用では、 SHA 一致を条件にすると再提出のたびに
   * 全段階をやり直すことになる。 モデルレビューが最も高いので、 内容が変わっていない
   * 載せ替えでそれを払い直すのは無駄。 判定は merge-base からの差分の指紋
   * (`git patch-id --stable`) で、 SHA だけ変わったヘッドを同一内容として扱う。
   *
   * 比較できない場合 (審査済み SHA が GC された等) は false を返す。 未知の内容を
   * 「審査済み」と見なす側に倒さない。
   */
  async #reviewedContentUnchanged(repository, pullRequest, refs) {
    const reviewed = pullRequest.reviewedHeadSha;
    if (typeof reviewed !== "string" || !reviewed) return false;
    if (reviewed.toLowerCase() === refs.headSha.toLowerCase()) return true;
    try {
      const [reviewedPatchId, currentPatchId] = await Promise.all([
        diffPatchId(repository.rootPath, reviewed, refs.baseSha),
        diffPatchId(repository.rootPath, refs.headSha, refs.baseSha),
      ]);
      return Boolean(reviewedPatchId) && reviewedPatchId === currentPatchId;
    } catch {
      return false;
    }
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

  async #requeue(pullRequest, {
    announceFailure = true,
    allowActiveSameHead = false,
    reviewLane = normalizeReviewLane(pullRequest.reviewLane),
  } = {}) {
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
    const active = pullRequest.checkStatus === "queued" || pullRequest.checkStatus === "running";
    if (
      !allowActiveSameHead
      && active
      && refs.headSha === pullRequest.headSha
      && this.#hasActiveReviewJob(pullRequest.id)
    ) {
      throw new Error(
        "A local PR under review cannot be re-queued at the same head; wait for it to finish.",
      );
    }
    await assertLocalVersionUnchanged(repository.rootPath, refs.baseSha, refs.headSha);
    let scope = retryReviewScope(pullRequest, refs.headSha, {
      reviewedContentUnchanged: await this.#reviewedContentUnchanged(repository, pullRequest, refs),
    });
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
        reviewLane: normalizeReviewLane(reviewLane),
      }),
      // The refs may be unchanged, and the queue caches settled jobs by exact
      // head, so an unforced re-review would resolve to the run being retried.
      { force: true },
      { announceFailure, requestOptions: { ...scope, previousReview } },
    );
  }

  #hasActiveReviewJob(pullRequestId, { unknownIsActive = true } = {}) {
    // 永続ジョブが無い queued / running は、ワーカー死亡後の古い PR 状態でしかない。
    // jobs が渡されない旧来の queue 実装では安全側に倒して従来の再投入拒否を維持する。
    if (!this.jobs || typeof this.jobs.list !== "function") return unknownIsActive;
    return this.jobs.list().some((job) =>
      (job.localPrId ?? job.request?.localPrId) === pullRequestId
      && (job.status === "queued" || job.status === "running"));
  }

  async #enqueue(repository, pullRequest, options, {
    announceFailure = true,
    requestOptions = {},
  } = {}) {
    try {
      // 審査の差分起点は、実際に squash 先となる merge repository の base ref から読む。
      // 登録元 checkout はマージのたびには追随しないので、 そちらを起点にすると他 PR が
      // マージしたぶんまでこの PR の変更として審査へ渡る (`review-diff-scope.md`)。
      const reviewRepository = await this.prepareMerge({
        repository,
        pullRequest,
        statePath: this.store.path,
      });
      await this.queue.submit(
        reviewRequest(repository, reviewRepository, pullRequest, requestOptions),
        options,
      );
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
    const settings = this.loadSettings();
    // Read the version before records so a concurrent write cannot pair a fresh token with old data.
    const version = this.store.listVersion?.() ?? null;
    return this.#listCache.read({
      version,
      settingsKey: decisionSettingsKey(settings),
      build: () => decidePullRequests(this.store.listPullRequests(), settings),
    });
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
  async mergePullRequest(id, { humanApproved = true, bypass = null, deferPush = false } = {}) {
    if (bypass && !String(bypass.reason ?? "").trim()) {
      throw new Error("A bypass merge requires a reason.");
    }
    return this.publicationCoordinator.run(() => this.lifecycleLockPath
      ? withFileLock(
        this.lifecycleLockPath,
        () => this.#mergeOnce(id, humanApproved, bypass, deferPush),
        { label: "merge-pull-request" },
      )
      : this.#mergeOnce(id, humanApproved, bypass, deferPush));
  }

  async #mergeOnce(id, humanApproved, bypass = null, deferPush = false) {
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
        ...(deferPush ? { deferPush: true } : {}),
        ...(bypass ? { bypass } : {}),
        ...(this.securityScan ? { scan: this.securityScan } : {}),
        ...(this.publisher ? { publish: this.publisher } : {}),
      });
      const mergeCommitSha = typeof publication === "string"
        ? publication
        : publication.mergeCommitSha;
      // GitHub へ届いたか保留したかは記録の上で区別する。 保留のままの PR を
      // `publishedAt` 付きで残すと、 後送 (`revisor publish-pending`) の対象が
      // 記録から辿れなくなる。
      const deferred = isDeferredPublication(publication);
      const merged = this.store.updatePullRequest(id, {
        status: "merged",
        checkStatus: "test_ok",
        reasons: [],
        mergeCommitSha,
        mergeError: null,
        releaseTag: typeof publication === "object" ? publication.releaseTag ?? null : null,
        releaseUrl: typeof publication === "object" ? publication.releaseUrl ?? null : null,
        publication: deferred ? PUBLICATION_DEFERRED : PUBLICATION_PUBLISHED,
        deferredPublishReason: deferred ? publication.deferredReason ?? null : null,
        publishedAt: deferred ? null : new Date().toISOString(),
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
      // 隔離 checkout でマージしたので、登録元フォルダの base は取り残される。
      // 次の PR が「main と競合」になる前に、安全に ff できるときだけ追随させる。
      // 同期できなくてもマージは成立しているので、理由を残して先へ進む。
      const sync = await this.syncCheckout({
        sourceRootPath: repository.rootPath,
        mergeRootPath,
        baseRef: pullRequest.baseRef,
      });
      if (!sync.synced) {
        process.stderr.write(
          `Revisor did not fast-forward ${repository.repository} ${pullRequest.baseRef}`
          + ` in ${repository.rootPath}: ${sync.reason}\n`,
        );
      }
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

  #assertFastLaneAvailable() {
    if ((this.loadSettings().fastLaneSlots ?? 0) < 1) {
      throw new Error(
        "Fast lane is unavailable: configure at least 2 workers and reserve 1 or 2 fast-lane slots.",
      );
    }
  }
}
