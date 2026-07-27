import { createSign } from "node:crypto";
import { RevisorError } from "./errors.mjs";

const API_VERSION = "2026-03-10";
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function repositoryPath(repository) {
  const [owner, name, extra] = repository.split("/");
  if (!owner || !name || extra) {
    throw new RevisorError(`Invalid GitHub repository '${repository}'.`);
  }
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

export function createAppJwt({
  appId,
  privateKey,
  now = () => Date.now(),
}) {
  const issuedAt = Math.floor(now() / 1000) - 60;
  const header = encodeJson({ alg: "RS256", typ: "JWT" });
  const payload = encodeJson({
    iat: issuedAt,
    exp: issuedAt + 10 * 60,
    iss: appId,
  });
  const unsigned = `${header}.${payload}`;
  try {
    const signature = createSign("RSA-SHA256")
      .update(unsigned)
      .end()
      .sign(privateKey)
      .toString("base64url");
    return `${unsigned}.${signature}`;
  } catch (error) {
    throw new RevisorError("GitHub App JWT could not be signed.", { cause: error });
  }
}

export class GitHubAppClient {
  #tokens = new Map();

  constructor({
    appId,
    privateKey,
    apiUrl = "https://api.github.com",
    transport = fetch,
    now = () => Date.now(),
  }) {
    if (typeof appId !== "string" || !appId.trim()) {
      throw new TypeError("GitHub App ID is required.");
    }
    if (typeof privateKey !== "string" || !privateKey.trim()) {
      throw new TypeError("GitHub App private key is required.");
    }
    this.appId = appId.trim();
    this.privateKey = privateKey;
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.transport = transport;
    this.now = now;
  }

  async request(repository, method, path, body) {
    const token = await this.#installationToken(repository);
    return this.#request(method, path, {
      token,
      body,
      expectedStatuses: method === "POST" ? [200, 201] : [200],
    });
  }

  async #installationToken(repository) {
    const cached = this.#tokens.get(repository);
    if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > this.now()) {
      return cached.token;
    }
    const jwt = createAppJwt({
      appId: this.appId,
      privateKey: this.privateKey,
      now: this.now,
    });
    const installation = await this.#request(
      "GET",
      `/repos/${repositoryPath(repository)}/installation`,
      { token: jwt, expectedStatuses: [200] },
    );
    if (!Number.isInteger(installation.id)) {
      throw new RevisorError(`GitHub App installation was not found for ${repository}.`);
    }
    const created = await this.#request(
      "POST",
      `/app/installations/${installation.id}/access_tokens`,
      {
        token: jwt,
        body: { permissions: { checks: "write" } },
        expectedStatuses: [201],
      },
    );
    if (typeof created.token !== "string" || !created.token) {
      throw new RevisorError("GitHub returned an invalid installation token.");
    }
    const expiresAt = Date.parse(created.expires_at);
    if (!Number.isFinite(expiresAt)) {
      throw new RevisorError("GitHub returned an invalid installation-token expiry.");
    }
    this.#tokens.set(repository, { token: created.token, expiresAt });
    return created.token;
  }

  async #request(method, path, { token, body, expectedStatuses }) {
    let response;
    try {
      response = await this.transport(`${this.apiUrl}${path}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "LUDIARS-Revisor",
          "X-GitHub-Api-Version": API_VERSION,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new RevisorError(`GitHub API ${method} ${path} failed.`, { cause: error });
    }
    const text = await response.text();
    let value = {};
    if (text) {
      try {
        value = JSON.parse(text);
      } catch (error) {
        throw new RevisorError(
          `GitHub API ${method} ${path} returned invalid JSON (${response.status}).`,
          { cause: error },
        );
      }
    }
    if (!expectedStatuses.includes(response.status)) {
      const message = typeof value.message === "string" ? `: ${value.message}` : "";
      throw new RevisorError(
        `GitHub API ${method} ${path} returned ${response.status}${message}`,
      );
    }
    return value;
  }
}
