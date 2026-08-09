import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { bearerToken, tokenMatches } from "./auth.mjs";
import { readAllowedHosts, readSettings, readWorkflowToken } from "./config.mjs";
import {
  validatePullRequestSubmission,
  validateRepositoryRegistration,
} from "./local-contracts.mjs";
import { isLoopbackAddress, isLoopbackHost } from "./host-policy.mjs";
import {
  notifyConcordia,
  notifyConcordiaChat,
  optionalConcordiaUrl,
} from "./concordia-context.mjs";
import { LocalPrReporter } from "./local-reporter.mjs";
import { notifyPullRequestLifecycle } from "./pr-lifecycle-notice.mjs";
import { notifyReviewCompletion } from "./review-completion-notice.mjs";
import { LocalPrService } from "./local-pr-service.mjs";
import { PrReviewQueue } from "./queue.mjs";
import { PublicationCoordinator } from "./publication-coordinator.mjs";
import { PrEventStream } from "./pr-event-stream.mjs";
import { attachPrWebSocket } from "./pr-websocket.mjs";
import { PullRequestDiffService } from "./pull-request-diff-service.mjs";
import {
  formatRepositoryAccessFailure,
  inspectRegisteredRepositories,
  unreachableRepositories,
} from "./repository-access.mjs";
import { ReleaseService } from "./release-service.mjs";
import { createPrReviewRunner } from "./runner.mjs";
import { ReviewStageWorkers } from "./review-stage-workers.mjs";
import { LocalPrStore, resolveStatePath } from "./state-store.mjs";
import { createUiRequestHandler, readJsonBody, sendJson } from "./ui-server.mjs";
import { PrReviewWorkerPool } from "./worker-pool.mjs";

function isLocalApi(pathname) {
  return pathname === "/v1/repositories"
    || pathname === "/v1/local-prs"
    || pathname.startsWith("/v1/local-prs/")
    || pathname === "/v1/test-workflow"
    || pathname === "/v1/review-work";
}

export function createRequestHandler({
  env = process.env,
  sessionToken,
  queue,
  reviewWorkers = null,
  pullRequestDiffs = null,
  localPrService,
  releaseService,
}) {
  const ui = createUiRequestHandler({
    env,
    sessionToken,
    queue,
    reviewWorkers,
    pullRequestDiffs,
    localPrService,
    releaseService,
  });
  return async (request, response) => {
    const host = request.headers.host ?? "127.0.0.1";
    const url = new URL(request.url ?? "/", `http://${host}`);
    if (!isLocalApi(url.pathname)) {
      await ui(request, response);
      return;
    }
    if (!isLoopbackAddress(request.socket?.remoteAddress)) {
      sendJson(response, 403, { error: "Loopback client required." });
      return;
    }
    // 読み取り (GET) は loopback 限定だけで通す。 変更系 (PR 提出・マージ・retry・
    // リポ登録) は従来どおり token を要求する。
    //
    // 一律 token にすると、 一覧を読むだけの同一マシン上のサービス (Concordia の
    // Test Forum 同期・PRs ページ) まで秘密の配布が要り、 その配布経路の不在だけで
    // 機能が止まる。 一方 token が本当に効くのはマージのような破壊的操作なので、
    // そちらには残す。
    //
    // 接続元アドレスに加えて Host も loopback を要求するのは DNS rebinding 対策。
    // 攻撃者のページが自ドメインを 127.0.0.1 に向ければ、 接続元は loopback かつ
    // ブラウザから見て same-origin になり、 CORS ヘッダが無くても本文が読める。
    // Host が 127.0.0.1 / localhost でない読み取りは、 従来どおり token を要求する。
    const tokenFreeRead = request.method === "GET" && isLoopbackHost(host);
    if (!tokenFreeRead) {
      let expected;
      try {
        expected = readWorkflowToken(env);
      } catch {
        sendJson(response, 503, { error: "Revisor is not configured." });
        return;
      }
      const supplied = bearerToken(request.headers.authorization)
        ?? request.headers["x-pr-gate-token"];
      if (!tokenMatches(expected, supplied)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
    }
    try {
      if (request.method === "POST" && url.pathname === "/v1/repositories") {
        const repository = await localPrService.registerRepository(
          validateRepositoryRegistration(await readJsonBody(request)),
        );
        sendJson(response, 201, { repository });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/repositories") {
        sendJson(response, 200, { repositories: localPrService.listRepositories() });
        return;
      }
      if (request.method === "POST" && url.pathname === "/v1/local-prs") {
        const pullRequest = await localPrService.submitPullRequest(
          validatePullRequestSubmission(await readJsonBody(request)),
        );
        sendJson(response, 202, { pullRequest });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/local-prs") {
        sendJson(response, 200, { pullRequests: localPrService.listPullRequests() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/test-workflow") {
        sendJson(response, 200, { products: localPrService.testWorkflowProducts() });
        return;
      }
      if (request.method === "GET" && url.pathname === "/v1/review-work") {
        sendJson(response, 200, {
          reviewQueue: queue.state(),
          workers: reviewWorkers?.state() ?? { queues: [] },
        });
        return;
      }
      const merge = /^\/v1\/local-prs\/([^/]+)\/merge$/.exec(url.pathname);
      if (request.method === "POST" && merge) {
        const pullRequest = await localPrService.mergePullRequest(
          decodeURIComponent(merge[1]),
        );
        sendJson(response, 200, { pullRequest });
        return;
      }
      const close = /^\/v1\/local-prs\/([^/]+)\/close$/.exec(url.pathname);
      if (request.method === "POST" && close) {
        const body = await readJsonBody(request).catch(() => null);
        const pullRequest = localPrService.closePullRequest(
          decodeURIComponent(close[1]),
          { reason: typeof body?.reason === "string" ? body.reason : null },
        );
        sendJson(response, 200, { pullRequest });
        return;
      }
      const retry = /^\/v1\/local-prs\/([^/]+)\/retry$/.exec(url.pathname);
      if (request.method === "POST" && retry) {
        const pullRequest = await localPrService.retryPullRequest(
          decodeURIComponent(retry[1]),
        );
        sendJson(response, 202, { pullRequest });
        return;
      }
      const detail = /^\/v1\/local-prs\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && detail) {
        const pullRequest = localPrService.getPullRequest(decodeURIComponent(detail[1]));
        sendJson(
          response,
          pullRequest ? 200 : 404,
          pullRequest ? { pullRequest } : { error: "Local PR not found." },
        );
        return;
      }
      sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      sendJson(response, 400, {
        error: error instanceof Error ? error.message : "Request failed.",
      });
    }
  };
}

export async function startRevisor({
  env = process.env,
  port,
  cwd = process.cwd(),
  runner,
  createWorkerPool = (options) => new PrReviewWorkerPool(options),
  createStageWorkers = (options) => new ReviewStageWorkers({
    ...options,
    createPool: createWorkerPool,
  }),
  createPullRequestDiffService = (options) => new PullRequestDiffService(options),
  stateStore,
  createLocalPrService = (options) => new LocalPrService(options),
  createReleaseService = (options) => new ReleaseService(options),
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Revisor port must be an integer from 1 to 65535.");
  }
  const settings = readSettings(env);
  const eventStream = new PrEventStream();
  const store = stateStore ?? new LocalPrStore({
    path: resolveStatePath(env),
    onEvent: eventStream.publish,
  });
  const publicationCoordinator = new PublicationCoordinator();
  // Late-bound on purpose: the reporter is constructed before the service that
  // owns merging, and the automatic merge has to run the moment a review lands.
  let localPrService;
  // 投稿元セッションへ終局結果を 1 通。Concordia の場所は catalog 由来なので、
  // 解決できない環境 (catalog 無し) では通知だけ落ちる。
  const announceCompletion = (pullRequest) => notifyReviewCompletion({
    pullRequest,
    baseUrl: optionalConcordiaUrl(cwd, readSettings(env).concordiaContextEnabled),
    notify: notifyConcordia,
  });
  // PR lifecycle は投稿元セッションの binding を使い、Concordia の共有「報告」
  // channel へ出す。Discord egress が有効なら #houkoku へ届く。レビュー文脈の
  // 設定とは独立した best-effort 観測経路で、session/catalog/Concordia 不在時は
  // no-op になる。
  const announceLifecycle = (event, pullRequest) => notifyPullRequestLifecycle({
    event,
    pullRequest,
    baseUrl: optionalConcordiaUrl(cwd, true),
    notify: notifyConcordiaChat,
  });
  const reporter = new LocalPrReporter(store, {
    afterCompleted: (id) => localPrService?.autoMergeIfEligible(id),
    notifyCompletion: announceCompletion,
    notifyReviewStatus: announceLifecycle,
  });
  const reviewWorkers = runner
    ? null
    : createStageWorkers({
      size: settings.workerCount,
      cwd,
      env,
      onStateChange: () => eventStream.publish({ type: "review_work.updated" }),
    });
  const jobRunner = runner ?? createPrReviewRunner({
    cwd,
    env,
    scheduleWork: (work, options) => reviewWorkers.run(work, options),
  });
  // This queue records lifecycle and admits orchestrators; it is deliberately
  // not a worker-capacity governor. A slow model review must not occupy a slot
  // that stops later PRs from reaching an idle dedicated test/Anatomia/security
  // worker. The stage pools own every expensive bounded operation, and runner
  // worktree mutations are separately serialized per source repository.
  const queue = new PrReviewQueue(jobRunner, {
    concurrency: Number.MAX_SAFE_INTEGER,
    reporter,
  });
  // `env` has to reach the service: the pre-merge security scan and the
  // auto-merge risk threshold both resolve their settings from it, and a service
  // left on process.env would decide under a different configuration than the one
  // /api/settings reads and writes.
  localPrService = createLocalPrService({
    store,
    queue,
    env,
    notifyLifecycle: announceLifecycle,
    publicationCoordinator,
  });
  const releaseService = createReleaseService({
    store,
    env,
    publicationCoordinator,
  });
  const pullRequestDiffs = createPullRequestDiffService({
    getPullRequest: (id) => localPrService.getPullRequest(id),
    getRepository: (repository) => localPrService.getRepository(repository),
  });
  const sessionToken = randomBytes(24).toString("base64url");
  const server = createServer(createRequestHandler({
    env,
    sessionToken,
    queue,
    reviewWorkers,
    pullRequestDiffs,
    localPrService,
    releaseService,
  }));
  const prWebSocket = attachPrWebSocket({
    server,
    eventStream,
    sessionToken,
    allowedHosts: () => readAllowedHosts(env),
  });
  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once("error", onError);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
  } catch (error) {
    prWebSocket.close();
    await reviewWorkers?.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    prWebSocket.close();
    await reviewWorkers?.close();
    server.close();
    throw new Error("Could not resolve the Revisor address.");
  }
  // 前回のプロセスが job 実行中に落ちていると、その PR は `running` / `queued` のまま
  // 残る。 キューは in-memory なので誰も拾わず、 再投入ガードにも弾かれて永久に動かない。
  // listen 後に拾い直す (git 参照解決が遅くてもポートの開通を遅らせない)。
  // 復旧そのものが落ちたときも、 listen 済みのサーバとワーカーを放置しない
  // (アドレス解決失敗と同じ後始末をしてから投げ直す)。
  let recovery;
  try {
    recovery = await localPrService.recoverInterruptedReviews();
  } catch (error) {
    prWebSocket.close();
    await reviewWorkers?.close();
    server.close();
    throw error;
  }
  if (recovery.scanned > 0) {
    process.stdout.write(
      `Revisor recovered interrupted reviews: scanned=${recovery.scanned}`
      + ` requeued=${recovery.recovered.length} failed=${recovery.failed.length}\n`,
    );
    for (const entry of recovery.failed) {
      process.stderr.write(
        `Revisor could not resume ${entry.repository} #${entry.number}: ${entry.reason}\n`,
      );
      // 復旧できなかった PR は reporter を通らずに `failed` になる。 ここで黙ると
      // 投稿元セッションは running のまま待ち続けるので、終局状態として 1 通送る。
      // 報告 channel 側の 1 通は recoverInterruptedReviews が既に出している。
      // 通知は best-effort: 失敗しても起動を止めない。
      try {
        const pullRequest = store.getPullRequest(entry.id);
        if (pullRequest) await announceCompletion(pullRequest);
      } catch {
        // 通知は落としてよい。
      }
    }
  }
  // 読めない登録 checkout は、 これまで「その repo のマージを試みた瞬間」に初めて
  // 失敗として現れた (所有者汚染はマージ直前の clone で落ちる)。 起動時に全件を
  // 名指しで出しておく。 確認そのものが失敗しても起動は止めない。
  try {
    const access = await inspectRegisteredRepositories(store.listRepositories());
    for (const failure of unreachableRepositories(access)) {
      process.stderr.write(
        `Revisor cannot read a registered checkout: ${formatRepositoryAccessFailure(failure)}\n`,
      );
    }
  } catch (error) {
    process.stderr.write(
      `Revisor could not check registered checkouts: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
  // レビュー完了時の 1 回きりだと「その瞬間 base が古かった」PR を二度と拾えない。
  // base が進んで squash が通るようになった Test OK を定期的に拾い直す。
  const autoMergeSweepTimer = setInterval(() => {
    localPrService.sweepAutoMerge()
      .then((summary) => {
        if (summary.merged > 0 || summary.failed > 0) {
          process.stdout.write(
            `Revisor auto-merge sweep: attempted=${summary.attempted}`
            + ` merged=${summary.merged} failed=${summary.failed}\n`,
          );
        }
      })
      .catch((error) => {
        process.stderr.write(`Revisor auto-merge sweep failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`);
      });
  }, 60_000);
  autoMergeSweepTimer.unref?.();
  return {
    url: `http://127.0.0.1:${address.port}/`,
    queue,
    reviewWorkers,
    pullRequestDiffs,
    store,
    eventStream,
    localPrService,
    releaseService,
    recovery,
    workerCount: settings.workerCount,
    close: async () => {
      clearInterval(autoMergeSweepTimer);
      prWebSocket.close();
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      await reviewWorkers?.close();
    },
  };
}
