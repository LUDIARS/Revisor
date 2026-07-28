import {
  hasWorkflowToken,
  readAllowedHosts,
  readSettings,
  writeAllowedHosts,
  writeWorkflowToken,
  writeSettings,
} from "./config.mjs";
import { resolveAnatomiaCli } from "./anatomia.mjs";
import {
  validatePullRequestSubmission,
  validateRepositoryRegistration,
} from "./local-contracts.mjs";
import { normalizeAllowedHosts } from "./host-policy.mjs";
import { renderDashboardPage } from "./ui-dashboard-page.mjs";
import { renderSettingsPage } from "./ui-settings-page.mjs";
import { isAllowedHost, isAuthorizedSession } from "./ui-security.mjs";

const PAGES = new Map([
  ["/", renderDashboardPage],
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

export async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new Error("Request body must be valid JSON.", { cause: error });
  }
}

export function createUiRequestHandler({
  env = process.env,
  sessionToken,
  queue,
  localPrService,
}) {
  let allowedHosts = readAllowedHosts(env);
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
            && hasWorkflowToken(env),
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
        });
        return;
      }
      if (request.method === "PUT" && url.pathname === "/api/settings") {
        const body = await readJsonBody(request);
        await resolveAnatomiaCli(body.anatomiaFolder);
        const nextAllowedHosts = body.allowedHosts === undefined
          ? allowedHosts
          : normalizeAllowedHosts(body.allowedHosts);
        const settings = writeSettings(body, env);
        if (body.allowedHosts !== undefined) {
          allowedHosts = writeAllowedHosts(nextAllowedHosts, env);
        }
        if (typeof body.workflowToken === "string" && body.workflowToken.trim()) {
          writeWorkflowToken(body.workflowToken, env);
        }
        sendJson(response, 200, {
          settings,
          allowedHosts,
          workflowTokenConfigured: hasWorkflowToken(env),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/jobs") {
        sendJson(response, 200, queue.state());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/repositories") {
        sendJson(response, 200, {
          repositories: localPrService.listRepositories(),
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
        sendJson(response, 200, {
          pullRequests: localPrService.listPullRequests(),
        });
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
      const merge = /^\/api\/local-prs\/([^/]+)\/merge$/.exec(url.pathname);
      if (request.method === "POST" && merge) {
        sendJson(response, 200, {
          pullRequest: await localPrService.mergePullRequest(
            decodeURIComponent(merge[1]),
          ),
        });
        return;
      }
      const retry = /^\/api\/local-prs\/([^/]+)\/retry$/.exec(url.pathname);
      if (request.method === "POST" && retry) {
        sendJson(response, 202, {
          pullRequest: await localPrService.retryPullRequest(
            decodeURIComponent(retry[1]),
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
