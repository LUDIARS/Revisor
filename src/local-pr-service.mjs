import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { autoMergeDecision, autoMergeRecord } from "./auto-merge.mjs";
import { readSettings } from "./config.mjs";
import { MergeConflictError, StaleReviewError } from "./errors.mjs";
import { installPushGuard } from "./push-guard.mjs";
import { pendingReviewProjection } from "./local-reporter.mjs";
import { redactSecretLines } from "./leakage.mjs";
import { squashMergeLocalPullRequest } from "./local-merge.mjs";
import { decidePullRequest, decidePullRequests } from "./pr-disposition.mjs";
import { inspectLocalPullRequest, git } from "./workspace.mjs";
import {
  assertLocalVersionUnchanged,
  prepareLocalVersionFile,
} from "./local-version.mjs";

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
    publisher,
    prepareVersionFile = prepareLocalVersionFile,
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
    this.publisher = publisher;
    this.prepareVersionFile = prepareVersionFile;
    this.env = env;
    this.cliPath = cliPath;
    this.notifyLifecycle = notifyLifecycle;
    // Read on every decision, not cached: moving the accepted risk threshold has
    // to re-colour and re-sort the dashboard without restarting the service.
    this.loadSettings = loadSettings;
  }

  // squash マージは base ref を前進させる。 定期スイープ・レビュー完了時の自動マージ
  // ・UI からの手動マージは互いを知らないので、 直列化しないと同じ baseSha から 2 本
  // 作って後の 1 本が必ず「base が動いた」で落ちる (実際にはマージ可能な PR が失敗
  // 扱いになる)。 マージは常に 1 本ずつ通す。
  #mergeChain = Promise.resolve();

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
   * 取り下げる。 マージせずに終わる PR (別経路で main へ入った / 案を破棄した) を
   * 終局させ、 board と test workflow から外す。
   *
   * 審査中とマージ中は拒否する。 どちらも走っている処理が完了時に自分の結果を
   * 書き戻すので、 先に closed にしても上書きされる — 審査なら open へ戻ったように
   * 見えるだけ、 マージなら取り下げたはずの変更がそのまま main へ入る。
   * 理由は必須にしない代わりに、 渡されたものは記録して後から辿れるようにする。
   */
  closePullRequest(id, { reason = null } = {}) {
    const pullRequest = this.store.getPullRequest(id);
    if (!pullRequest) throw new Error(`Local PR '${id}' was not found.`);
    if (pullRequest.status !== "open") {
      throw new Error(`Only an open local PR can be closed (it is '${pullRequest.status}').`);
    }
    if (pullRequest.checkStatus === "queued" || pullRequest.checkStatus === "running") {
      throw new Error("A local PR under review cannot be closed; wait for the review to finish.");
    }
    if (this.#merging.has(id)) {
      throw new Error("A local PR being merged cannot be closed; wait for the merge to finish.");
    }
    return this.store.updatePullRequest(id, {
      status: "closed",
      closedAt: new Date().toISOString(),
      closeReason: typeof reason === "string" && reason.trim() ? reason.trim() : null,
    });
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
    await assertLocalVersionUnchanged(repository.rootPath, refs.baseSha, refs.headSha);
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
    const merge = this.#mergeChain.then(
      () => this.#mergeOnce(id),
      () => this.#mergeOnce(id),
    );
    // 失敗した 1 件で後続を止めない。 チェーンは順番だけを保証する。
    this.#mergeChain = merge.then(() => undefined, () => undefined);
    return merge;
  }

  async #mergeOnce(id) {
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
    try {
      const publication = await this.merge({
        repository,
        pullRequest,
        env: this.env,
        ...(this.securityScan ? { scan: this.securityScan } : {}),
        ...(this.publisher ? { publish: this.publisher } : {}),
      });
      const mergeCommitSha = typeof publication === "string"
        ? publication
        : publication.mergeCommitSha;
      const merged = this.store.updatePullRequest(id, {
        status: "merged",
        checkStatus: "test_ok",
        mergeCommitSha,
        mergeError: null,
        releaseTag: typeof publication === "object" ? publication.releaseTag ?? null : null,
        releaseUrl: typeof publication === "object" ? publication.releaseUrl ?? null : null,
        publishedAt: new Date().toISOString(),
        mergedAt: new Date().toISOString(),
      });
      await this.#announceLifecycle("merged", merged);
      return merged;
    } catch (error) {
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
      if (error instanceof StaleReviewError) {
        await this.#requeue(pullRequest);
        throw error;
      }
      // A publication failure carries Git and GitHub API text straight onto the
      // decision board and into notifications, so it obeys the same boundary as
      // any other stored free-form output: locations survive, secrets do not.
      this.store.updatePullRequest(id, {
        mergeError: redactSecretLines(
          error instanceof Error ? error.message : String(error),
        ),
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
        && pullRequest.checkStatus === "test_ok"
        && pullRequest.draft !== true);
      for (const candidate of candidates) {
        // 1 件マージするたびに base は進み、レビュー完了や手動マージも並行して状態を
        // 動かす。 候補一覧は周回の開始時点のスナップショットなので、判定は必ず最新の
        // 記録で取り直す (でないと既にマージ済みの PR を再度マージしにいく)。
        const pullRequest = this.store.getPullRequest(candidate.id);
        if (
          !pullRequest
          || pullRequest.status !== "open"
          || pullRequest.checkStatus !== "test_ok"
          || pullRequest.draft === true
        ) continue;
        const decision = autoMergeDecision(pullRequest, settings);
        if (!decision.merge) continue;
        summary.attempted += 1;
        try {
          await this.mergePullRequest(pullRequest.id);
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
      await this.mergePullRequest(id);
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
