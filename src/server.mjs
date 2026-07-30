import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { bearerToken, tokenMatches } from "./auth.mjs";
import { readSettings, readWorkflowToken } from "./config.mjs";
import {
  validatePullRequestSubmission,
  validateRepositoryRegistration,
} from "./local-contracts.mjs";
import { LocalPrReporter } from "./local-reporter.mjs";
import { LocalPrService } from "./local-pr-service.mjs";
import { PrReviewQueue } from "./queue.mjs";
import { LocalPrStore, resolveStatePath } from "./state-store.mjs";
import { createUiRequestHandler, readJsonBody, sendJson } from "./ui-server.mjs";
import { PrReviewWorkerPool } from "./worker-pool.mjs";

function isLocalApi(pathname) {
  return pathname === "/v1/repositories"
    || pathname === "/v1/local-prs"
    || pathname.startsWith("/v1/local-prs/")
    || pathname === "/v1/test-workflow";
}

function isLoopbackAddress(address) {
  return !address
    || address === "::1"
    || address === "127.0.0.1"
    || address.startsWith("::ffff:127.");
}

export function createRequestHandler({
  env = process.env,
  sessionToken,
  queue,
  localPrService,
}) {
  const ui = createUiRequestHandler({ env, sessionToken, queue, localPrService });
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
      const merge = /^\/v1\/local-prs\/([^/]+)\/merge$/.exec(url.pathname);
      if (request.method === "POST" && merge) {
        const pullRequest = await localPrService.mergePullRequest(
          decodeURIComponent(merge[1]),
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
  stateStore,
  createLocalPrService = (options) => new LocalPrService(options),
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Revisor port must be an integer from 1 to 65535.");
  }
  const settings = readSettings(env);
  const store = stateStore ?? new LocalPrStore({ path: resolveStatePath(env) });
  const reporter = new LocalPrReporter(store);
  const workerPool = runner
    ? null
    : createWorkerPool({ size: settings.workerCount, cwd, env });
  const jobRunner = runner ?? ((request) => workerPool.run(request));
  const queue = new PrReviewQueue(jobRunner, {
    concurrency: settings.workerCount,
    reporter,
  });
  // `env` has to reach the service: the pre-merge security scan resolves its
  // settings from it, and a service left on process.env would scan under a
  // different configuration than the one /api/settings reads and writes.
  const localPrService = createLocalPrService({ store, queue, env });
  const sessionToken = randomBytes(24).toString("base64url");
  const server = createServer(createRequestHandler({
    env,
    sessionToken,
    queue,
    localPrService,
  }));
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
    await workerPool?.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === "string") {
    await workerPool?.close();
    server.close();
    throw new Error("Could not resolve the Revisor address.");
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    queue,
    store,
    localPrService,
    workerCount: settings.workerCount,
    close: async () => {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      await workerPool?.close();
    },
  };
}
