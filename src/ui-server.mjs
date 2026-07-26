import {
  hasOriginToken,
  readSettings,
  writeOriginToken,
  writeSettings,
} from "./config.mjs";
import { resolveAnatomiaCli } from "./anatomia.mjs";
import { renderSettingsPage } from "./ui-page.mjs";
import { isAuthorizedSession, isLoopbackHost } from "./ui-security.mjs";

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
}) {
  return async (request, response) => {
    if (!isLoopbackHost(request.headers.host)) {
      sendJson(response, 403, { error: "Loopback host required." });
      return;
    }
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (request.method === "GET" && url.pathname === "/health") {
      try {
        sendJson(response, 200, {
          status: "ok",
          configured: Boolean(readSettings(env).anatomiaFolder) && hasOriginToken(env),
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
    if (request.method === "GET" && url.pathname === "/") {
      send(
        response,
        200,
        "text/html; charset=utf-8",
        renderSettingsPage(sessionToken),
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
          originTokenConfigured: hasOriginToken(env),
        });
        return;
      }
      if (request.method === "PUT" && url.pathname === "/api/settings") {
        const body = await readJsonBody(request);
        await resolveAnatomiaCli(body.anatomiaFolder);
        const settings = writeSettings(body, env);
        if (typeof body.originToken === "string" && body.originToken.trim()) {
          writeOriginToken(body.originToken, env);
        }
        sendJson(response, 200, {
          settings,
          originTokenConfigured: hasOriginToken(env),
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/jobs") {
        sendJson(response, 200, queue.state());
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
