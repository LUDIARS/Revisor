import { createSign } from "node:crypto";
import { RevisorError } from "./errors.mjs";

const API_VERSION = "2026-03-10";
const API_URL = "https://api.github.com";
const TOKEN_REFRESH_MARGIN_MS = 2 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function repositoryPath(repository) {
  const [owner, name, extra] = String(repository).split("/");
  if (!owner || !name || extra) {
    throw new RevisorError(`Invalid GitHub repository '${repository}'.`);
  }
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

export function createAppJwt({ appId, privateKey, now = () => Date.now() }) {
  const issuedAt = Math.floor(now() / 1000) - 60;
  const header = encodeJson({ alg: "RS256", typ: "JWT" });
  const payload = encodeJson({ iat: issuedAt, exp: issuedAt + 9 * 60, iss: appId });
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
    apiUrl = API_URL,
    transport = fetch,
    now = () => Date.now(),
  }) {
    if (!/^\d+$/.test(String(appId ?? ""))) {
      throw new TypeError("GitHub App id is required.");
    }
    if (typeof privateKey !== "string" || !privateKey.trim()) {
      throw new TypeError("GitHub App private key is required.");
    }
    this.appId = String(appId);
    this.privateKey = privateKey;
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.transport = transport;
    this.now = now;
  }

  async installationToken(repository) {
    const cached = this.#tokens.get(repository.toLowerCase());
    if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > this.now()) {
      return cached.token;
    }
    const jwt = createAppJwt({
      appId: this.appId,
      privateKey: this.privateKey,
      now: this.now,
    });
    const installationResponse = await this.#request(
      "GET",
      `/repos/${repositoryPath(repository)}/installation`,
      { token: jwt, expectedStatuses: [200] },
    );
    const installation = installationResponse.body;
    if (!Number.isInteger(installation.id)) {
      throw new RevisorError(`GitHub App installation was not found for ${repository}.`);
    }
    const permissions = { contents: "write" };
    if (installation.permissions?.workflows === "write") permissions.workflows = "write";
    const issuedResponse = await this.#request(
      "POST",
      `/app/installations/${installation.id}/access_tokens`,
      {
        token: jwt,
        body: { repositories: [repository.split("/")[1]], permissions },
        expectedStatuses: [201],
      },
    );
    const issued = issuedResponse.body;
    if (typeof issued.token !== "string" || !issued.token) {
      throw new RevisorError("GitHub returned an invalid installation token.");
    }
    const expiresAt = Date.parse(issued.expires_at);
    if (!Number.isFinite(expiresAt)) {
      throw new RevisorError("GitHub returned an invalid installation-token expiry.");
    }
    this.#tokens.set(repository.toLowerCase(), { token: issued.token, expiresAt });
    return issued.token;
  }

  async releaseByTag(repository, tag) {
    const token = await this.installationToken(repository);
    const result = await this.#request(
      "GET",
      `/repos/${repositoryPath(repository)}/releases/tags/${encodeURIComponent(tag)}`,
      { token, expectedStatuses: [200, 404] },
    );
    return result.status === 404 ? null : result.body;
  }

  async createRelease(repository, release) {
    const token = await this.installationToken(repository);
    const result = await this.#request(
      "POST",
      `/repos/${repositoryPath(repository)}/releases`,
      { token, body: release, expectedStatuses: [201] },
    );
    return result.body;
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
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
      // 呼び出し側が「App 未インストール (installation 404)」だけを他の失敗と区別
      // できるように、 状態コードと経路を構造化して添える。 文言の照合に頼ると、
      // GitHub のメッセージが変わった日に判定が静かに壊れる。
      const error = new RevisorError(
        `GitHub API ${method} ${path} returned ${response.status}${message}`,
      );
      error.status = response.status;
      error.apiPath = path;
      throw error;
    }
    return { status: response.status, body: value };
  }
}
