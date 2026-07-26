import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { bearerToken, tokenMatches } from "./auth.mjs";
import { readOriginToken, readSettings } from "./config.mjs";
import { PrReviewQueue } from "./queue.mjs";
import { createUiRequestHandler, readJsonBody, sendJson } from "./ui-server.mjs";
import { PrReviewWorkerPool } from "./worker-pool.mjs";

const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HEAD_SHA = /^[0-9a-f]{40,64}$/i;

function validateRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Request body must be an object.");
  }
  if (!REPOSITORY.test(body.repository ?? "")) throw new Error("repository is invalid.");
  if (!Number.isInteger(body.number) || body.number < 1) throw new Error("number is invalid.");
  if (!HEAD_SHA.test(body.head_sha ?? "")) throw new Error("head_sha is invalid.");
  if (typeof body.head_ref !== "string" || !body.head_ref || body.head_ref.length > 255) {
    throw new Error("head_ref is invalid.");
  }
  if (!REPOSITORY.test(body.head_repository ?? "")) {
    throw new Error("head_repository is invalid.");
  }
  if (typeof body.base_ref !== "string" || !body.base_ref || body.base_ref.length > 255) {
    throw new Error("base_ref is invalid.");
  }
  if (body.repository !== body.head_repository) {
    throw new Error("Fork pull requests are not eligible for the local autofix review.");
  }
  return {
    repository: body.repository,
    number: body.number,
    headSha: body.head_sha,
    headRef: body.head_ref,
    headRepository: body.head_repository,
    baseRef: body.base_ref,
    pullRequestUrl: typeof body.pull_request_url === "string"
      ? body.pull_request_url
      : undefined,
  };
}

function isPrApi(pathname) {
  return pathname === "/v1/pr-gate/jobs"
    || pathname.startsWith("/v1/pr-gate/jobs/");
}

export function createRequestHandler({
  env = process.env,
  sessionToken,
  queue,
}) {
  const ui = createUiRequestHandler({ env, sessionToken, queue });
  return async (request, response) => {
    const host = request.headers.host ?? "127.0.0.1";
    const url = new URL(request.url ?? "/", `http://${host}`);
    if (!isPrApi(url.pathname)) {
      await ui(request, response);
      return;
    }
    let expected;
    try {
      expected = readOriginToken(env);
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
      if (request.method === "POST" && url.pathname === "/v1/pr-gate/jobs") {
        const job = queue.submit(validateRequest(await readJsonBody(request)));
        sendJson(response, 202, { id: job.id, status: job.status });
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/v1/pr-gate/jobs/")) {
        const id = decodeURIComponent(url.pathname.slice("/v1/pr-gate/jobs/".length));
        const job = queue.get(id);
        sendJson(response, job ? 200 : 404, job ?? { error: "job not found" });
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
} = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Revisor port must be an integer from 1 to 65535.");
  }
  const settings = readSettings(env);
  const workerPool = runner
    ? null
    : createWorkerPool({ size: settings.workerCount, cwd, env });
  const jobRunner = runner ?? ((request) => workerPool.run(request));
  const queue = new PrReviewQueue(jobRunner, { concurrency: settings.workerCount });
  const sessionToken = randomBytes(24).toString("base64url");
  const server = createServer(createRequestHandler({ env, sessionToken, queue }));
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
    workerCount: settings.workerCount,
    close: async () => {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      await workerPool?.close();
    },
  };
}
