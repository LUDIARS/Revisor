import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { bearerToken, tokenMatches } from "./auth.mjs";
import { readAllowedHosts, readWorkflowToken } from "./config.mjs";
import {
  validateFastLanePromotion,
  validatePullRequestSubmission,
  validateRepositoryRegistration,
  validateReviewRetry,
} from "./local-contracts.mjs";
import { isLoopbackAddress, isLoopbackHost } from "./host-policy.mjs";
import { PrEventStream } from "./pr-event-stream.mjs";
import { attachPrWebSocket } from "./pr-websocket.mjs";
import { PullRequestDiffService } from "./pull-request-diff-service.mjs";
import {
  formatRepositoryAccessFailure,
  inspectRegisteredRepositories,
  unreachableRepositories,
} from "./repository-access.mjs";
import { ReleaseService } from "./release-service.mjs";
import { createReviewContext } from "./review-context.mjs";
import { createUiRequestHandler, readJsonBody, sendJson } from "./ui-server.mjs";
import { ensureReviewWorker } from "./worker-spawn.mjs";
import { readWorkerState } from "./worker-state.mjs";

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
        const pullRequest = await localPrService.closePullRequest(
          decodeURIComponent(close[1]),
          { reason: typeof body?.reason === "string" ? body.reason : null },
        );
        sendJson(response, 200, { pullRequest });
        return;
      }
      const retry = /^\/v1\/local-prs\/([^/]+)\/retry$/.exec(url.pathname);
      if (request.method === "POST" && retry) {
        const retryOptions = validateReviewRetry(
          await readJsonBody(request, { optional: true }),
        );
        const pullRequest = await localPrService.retryPullRequest(
          decodeURIComponent(retry[1]),
          retryOptions,
        );
        sendJson(response, 202, { pullRequest });
        return;
      }
      const fastLane = /^\/v1\/local-prs\/([^/]+)\/fast-lane$/.exec(url.pathname);
      if (request.method === "POST" && fastLane) {
        const promotion = validateFastLanePromotion(
          await readJsonBody(request, { optional: true }),
        );
        const pullRequest = await localPrService.promotePullRequest(
          decodeURIComponent(fastLane[1]),
          promotion,
        );
        sendJson(response, 200, { pullRequest });
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
  createPullRequestDiffService = (options) => new PullRequestDiffService(options),
  stateStore,
  createReleaseService = (options) => new ReleaseService(options),
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Revisor port must be an integer from 1 to 65535.");
  }
  const eventStream = new PrEventStream();
  // サーバは審査を実行しない。 UI と読み書き API を提供し、投入されたキューは短命ワーカー
  // (`revisor run-worker`) が空にする。 これで審査の進行がサーバの生存に依存しなくなり、
  // サーバを落としたまま CLI だけで運用できる。
  const context = createReviewContext({
    cwd,
    env,
    onEvent: eventStream.publish,
    stateStore,
    onWorkerError: (error) => process.stderr.write(
      `Revisor could not start a review worker: ${error.message}\n`,
    ),
  });
  const { settings, store, queue, localPrService } = context;
  // 段階ワーカーのプールは審査を実行するプロセス (短命ワーカー) が持つ。 サーバ側は
  // その状態をメモリでは知り得ないので、 ワーカーが書いた状態ファイルを読んで返す。
  // 読み取り専用の窓であり、 サーバがプールを所有するわけではない (close も持たない)。
  const reviewWorkers = { state: () => readWorkerState(context.jobs.path) };
  const releaseService = createReleaseService({
    store,
    env,
    publicationCoordinator: context.publicationCoordinator,
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
    await reviewWorkers?.close?.();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    prWebSocket.close();
    await reviewWorkers?.close?.();
    server.close();
    throw new Error("Could not resolve the Revisor address.");
  }
  // 中断された審査の拾い直しも、 base が進んでマージ可能になった Test OK の回収も、
  // ワーカーが起動時と終了時に行う。 サーバ起動時の一括再投入と 60 秒周期タイマーは、
  // どちらもサーバの生存に依存する仕掛けなので置かない。 ここでは「積み残しがあるなら
  // ワーカーを起こす」だけにする。
  const wake = await ensureReviewWorker({ jobsPath: context.jobs.path, cwd, env })
    .catch((error) => ({ started: false, reason: error.message }));
  if (!wake.started && wake.reason) {
    process.stdout.write(`Revisor did not start a review worker: ${wake.reason}\n`);
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

  return {
    url: `http://127.0.0.1:${address.port}/`,
    queue,
    reviewWorkers,
    pullRequestDiffs,
    store,
    eventStream,
    localPrService,
    releaseService,
    workerCount: settings.workerCount,
    close: async () => {
      prWebSocket.close();
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}
