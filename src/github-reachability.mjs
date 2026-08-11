import { readGitHubAppCredentials } from "./config.mjs";
import { GitHubAppClient } from "./github-app.mjs";

/**
 * publish が GitHub へ到達できるかの判定だけを持つ。
 *
 * `GET /repos/<owner>/<name>/installation` が 404 を返すのは「その org / repo に
 * GitHub App が入っていない」場合で、 これは再試行しても解けない構成上の事実。
 * ローカルのマージまで巻き戻す理由が無いので、 保留 (deferred) 経路へ落とす。
 * 認証失敗・ネットワーク断・500 などは黙って保留にすると障害を隠すため、
 * 従来どおりそのまま投げる (`spec/plan/deferred-publish-design.md` §1.1)。
 */
export function isInstallationNotFound(error) {
  if (!error) return false;
  if (
    error.status === 404
    && typeof error.apiPath === "string"
    && error.apiPath.endsWith("/installation")
  ) {
    return true;
  }
  return /\/installation returned 404\b/.test(String(error.message ?? ""));
}

/**
 * @returns {Promise<{reachable: true, client: object, token: string}
 *   | {reachable: false, reason: string}>}
 */
export async function resolveGitHubAccess({
  repository,
  env = process.env,
  deferPush = false,
  readCredentials = readGitHubAppCredentials,
  createClient = (credentials) => new GitHubAppClient(credentials),
}) {
  // 明示保留では GitHub クライアントを組み立てない。 資格情報の復号すら行わない
  // ことが「送らない」の担保になる。
  if (deferPush) {
    return { reachable: false, reason: "--defer-push was requested." };
  }
  let client;
  let token;
  try {
    client = createClient(readCredentials(env));
    token = await client.installationToken(repository.repository);
  } catch (error) {
    if (!isInstallationNotFound(error)) throw error;
    return {
      reachable: false,
      reason: `The GitHub App is not installed for ${repository.repository}.`,
    };
  }
  return { reachable: true, client, token };
}
