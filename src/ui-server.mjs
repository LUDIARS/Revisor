import {
  hasWorkflowToken,
  hasGitHubAppCredentials,
  readAllowedHosts,
  readSettings,
  resolveToolFolder,
  writeAllowedHosts,
  writeWorkflowToken,
  writeGitHubAppCredentials,
  removeGitHubAppCredentials,
  writeSettings,
} from "./config.mjs";
import { resolveAnatomiaCli } from "./anatomia.mjs";
import {
  validateReviewRetry,
  validatePullRequestSubmission,
  validateRepositoryRegistration,
} from "./local-contracts.mjs";
import {
  validateManualRelease,
  validateVersionInitialization,
} from "./release-contracts.mjs";
import { renderDashboardPage } from "./ui-dashboard-page.mjs";
import { renderPrBoardPage } from "./ui-pr-board-page.mjs";
import { renderReleasePage } from "./ui-release-page.mjs";
import { renderSettingsPage } from "./ui-settings-page.mjs";
import { isAllowedHost, isAuthorizedSession } from "./ui-security.mjs";
import { LIST_STATES, ListResponseCache, listResponseBody } from "./pr-list-cache.mjs";

const PAGES = new Map([
  ["/", renderPrBoardPage],
  ["/dashboard", renderDashboardPage],
  ["/releases", renderReleasePage],
  ["/settings", renderSettingsPage],
]);

const MAX_BODY_BYTES = 64 * 1024;

function send(response, status, contentType, body, headers = {}) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...headers,
  });
  response.end(body);
}

export function sendJson(response, status, body) {
  send(response, status, "application/json; charset=utf-8", JSON.stringify(body));
}

export function sendSerializedJson(response, status, body) {
  send(response, status, "application/json; charset=utf-8", body);
}

export async function readJsonBody(request, { optional = false } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (optional && body.length === 0) return null;
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error("Request body must be valid JSON.", { cause: error });
  }
}

export function createUiRequestHandler({
  env = process.env,
  sessionToken,
  queue,
  reviewWorkers = null,
  pullRequestDiffs = null,
  localPrService,
  releaseService,
}) {
  let allowedHosts = readAllowedHosts(env);
  const listBody = new ListResponseCache();
  return async (request, response) => {
    if (!isAllowedHost(request.headers.host, allowedHosts)) {
      sendJson(response, 403, {
        error: "Host is not allowed. Configure it from a loopback address first.",
      });
      return;
    }
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (request.method === "GET" && url.pathname === "/health") {
      try {
        sendJson(response, 200, {
          status: "ok",
          configured: Boolean(readSettings(env).anatomiaFolder)
            && hasWorkflowToken(env)
            && hasGitHubAppCredentials(env),
        });
      } catch (error) {
        sendJson(response, 503, {
          status: "error",
          configured: false,
          error: error instanceof Error ? error.message : "Configuration is unreadable.",
        });
      }
      return;
    }
    const renderRequestedPage = PAGES.get(url.pathname);
    if (request.method === "GET" && renderRequestedPage) {
      send(
        response,
        200,
        "text/html; charset=utf-8",
        renderRequestedPage(sessionToken),
        {
          "Content-Security-Policy": `default-src 'self'; script-src 'nonce-${sessionToken}'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'`,
        },
      );
      return;
    }
    if (!isAuthorizedSession(request.headers, sessionToken)) {
      sendJson(response, 403, { error: "Invalid UI session." });
      return;
    }
    try {
      if (request.method === "GET" && url.pathname === "/api/settings") {
        sendJson(response, 200, {
          settings: readSettings(env),
          allowedHosts,
          workflowTokenConfigured: hasWorkflowToken(env),
          githubAppConfigured: hasGitHubAppCredentials(env),
        });
        return;
      }
      if (request.method === "PUT" && url.pathname === "/api/settings") {
        const body = await readJsonBody(request);
        // Allowed hosts now belong to their own endpoint. Refuse the field here
        // instead of dropping it: this response echoes `allowedHosts`, so a 200
        // would report a host registration that never reached the config.
        if (body.allowedHosts !== undefined) {
          throw new Error(
            "Allowed hosts are saved from PUT /api/settings/allowed-hosts.",
          );
        }
        // Validate the same absolute location that writeSettings persists.
        // Checking the raw relative path here would use the server cwd instead.
        await resolveAnatomiaCli(resolveToolFolder(body.anatomiaFolder, env));
        const settings = writeSettings(body, env);
        if (typeof body.workflowToken === "string" && body.workflowToken.trim()) {
          writeWorkflowToken(body.workflowToken, env);
        }
        if (body.removeGitHubApp === true) {
          removeGitHubAppCredentials(env);
        } else if (
          typeof body.githubAppPrivateKey === "string"
          && body.githubAppPrivateKey.trim()
        ) {
          writeGitHubAppCredentials({
            appId: body.githubAppId,
            privateKey: body.githubAppPrivateKey,
          }, env);
        }
        sendJson(response, 200, {
          settings,
          allowedHosts,
          workflowTokenConfigured: hasWorkflowToken(env),
          githubAppConfigured: hasGitHubAppCredentials(env),
        });
        return;
      }
      // This endpoint stays independent of the initial settings boundary:
      // writeSettings requires a valid Anatomia folder, but a loopback operator
      // may need to allow the external host used to finish that setup remotely.
      if (request.method === "PUT" && url.pathname === "/api/settings/allowed-hosts") {
        const body = await readJsonBody(request);
        allowedHosts = writeAllowedHosts(body.allowedHosts, env);
        sendJson(response, 200, { allowedHosts });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/jobs") {
        sendJson(response, 200, queue.state());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/review-work") {
        sendJson(response, 200, {
          reviewQueue: queue.state(),
          workers: reviewWorkers?.state() ?? { queues: [] },
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/repositories") {
        sendJson(response, 200, {
          repositories: localPrService.listRepositories(),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/releases") {
        sendJson(response, 200, {
          projects: await releaseService.listProjects(),
        });
        return;
      }
      const initializeRelease = /^\/api\/releases\/([^/]+)\/initialize$/.exec(url.pathname);
      if (request.method === "POST" && initializeRelease) {
        const input = validateVersionInitialization(await readJsonBody(request));
        sendJson(response, 200, {
          project: await releaseService.initialize(
            decodeURIComponent(initializeRelease[1]),
            input.version,
          ),
        });
        return;
      }
      const publishRelease = /^\/api\/releases\/([^/]+)\/publish$/.exec(url.pathname);
      if (request.method === "POST" && publishRelease) {
        sendJson(response, 200, {
          release: await releaseService.release(
            decodeURIComponent(publishRelease[1]),
            validateManualRelease(await readJsonBody(request)),
          ),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/repositories") {
        sendJson(response, 201, {
          repository: await localPrService.registerRepository(
            validateRepositoryRegistration(await readJsonBody(request)),
          ),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/local-prs") {
        const view = url.searchParams.get("view") ?? "full";
        const state = url.searchParams.get("state") ?? "all";
        if ((view !== "full" && view !== "summary") || !LIST_STATES.has(state)) {
          sendJson(response, 400, {
            error: "view must be full|summary and state must be open|merged|closed|all.",
          });
          return;
        }
        const pullRequests = localPrService.listPullRequests();
        sendSerializedJson(response, 200, listBody.render(
          pullRequests,
          view + "|" + state,
          () => listResponseBody(pullRequests, { view, state }),
        ));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/local-prs") {
        sendJson(response, 202, {
          pullRequest: await localPrService.submitPullRequest(
            validatePullRequestSubmission(await readJsonBody(request)),
          ),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/test-workflow") {
        sendJson(response, 200, {
          products: localPrService.testWorkflowProducts(),
        });
        return;
      }
      const files = /^\/api\/local-prs\/([^/]+)\/files$/.exec(url.pathname);
      if (request.method === "GET" && files) {
        if (!pullRequestDiffs) throw new Error("Pull-request diff reader is unavailable.");
        sendJson(response, 200, await pullRequestDiffs.files(decodeURIComponent(files[1])));
        return;
      }
      const diff = /^\/api\/local-prs\/([^/]+)\/diff$/.exec(url.pathname);
      if (request.method === "GET" && diff) {
        if (!pullRequestDiffs) throw new Error("Pull-request diff reader is unavailable.");
        sendJson(response, 200, await pullRequestDiffs.fileDiff(
          decodeURIComponent(diff[1]),
          url.searchParams.get("path"),
        ));
        return;
      }
      const merge = /^\/api\/local-prs\/([^/]+)\/merge$/.exec(url.pathname);
      if (request.method === "POST" && merge) {
        sendJson(response, 200, {
          pullRequest: await localPrService.mergePullRequest(
            decodeURIComponent(merge[1]),
          ),
        });
        return;
      }
      const close = /^\/api\/local-prs\/([^/]+)\/close$/.exec(url.pathname);
      if (request.method === "POST" && close) {
        const body = await readJsonBody(request).catch(() => null);
        sendJson(response, 200, {
          pullRequest: await localPrService.closePullRequest(decodeURIComponent(close[1]), {
            reason: typeof body?.reason === "string" ? body.reason : null,
          }),
        });
        return;
      }
      const retry = /^\/api\/local-prs\/([^/]+)\/retry$/.exec(url.pathname);
      if (request.method === "POST" && retry) {
        const retryOptions = validateReviewRetry(
          await readJsonBody(request, { optional: true }),
        );
        sendJson(response, 202, {
          pullRequest: await localPrService.retryPullRequest(
            decodeURIComponent(retry[1]),
            retryOptions,
          ),
        });
        return;
      }
      const fastLane = /^\/api\/local-prs\/([^/]+)\/fast-lane$/.exec(url.pathname);
      if (request.method === "POST" && fastLane) {
        sendJson(response, 200, {
          pullRequest: await localPrService.promotePullRequest(
            decodeURIComponent(fastLane[1]),
          ),
        });
        return;
      }
      const detail = /^\/api\/local-prs\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && detail) {
        const pullRequest = localPrService.getPullRequest(decodeURIComponent(detail[1]));
        if (!pullRequest) {
          sendJson(response, 404, { error: "Local PR was not found." });
          return;
        }
        sendJson(response, 200, { pullRequest });
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
