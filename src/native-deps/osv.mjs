/**
 * @implements RV-NATIVE-DEPS-02 — known vulnerabilities of C++ dependencies from OSV.
 *
 * Human decision (2026-11-07): query the OSV API (osv.dev). Only library
 * identities leave the host — repository URL and tag, commit hash, or Conan
 * name and version. No source text, path content or repository-private data
 * is sent.
 *
 * - 40-hex revision                -> {"commit": sha}
 * - repository + tag               -> {"package": {"name": repo-url, "ecosystem": "GIT"}, "version": tag}
 * - Conan name/version             -> {"package": {"name", "ecosystem": "ConanCenter"}, "version"}
 *
 * SRP: building OSV queries and reading querybatch results.
 */

export const OSV_QUERYBATCH = "https://api.osv.dev/v1/querybatch";
const BATCH_LIMIT = 1000;
const TIMEOUT_MS = 30_000;
const COMMIT = /^[0-9a-f]{40}$/i;

/**
 * Canonical repository URL OSV indexes GIT ranges under (`https://host/owner/repo`).
 * @implements RV-NATIVE-DEPS-02
 */
export function canonicalRepository(url) {
  const trimmed = String(url).trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  const ssh = /^git@([^:]+):(.+)$/.exec(trimmed);
  const https = ssh ? `https://${ssh[1]}/${ssh[2]}` : trimmed.replace(/^git:\/\//i, "https://").replace(/^http:\/\//i, "https://");
  return https.replace(/^https:\/\/([^/]+)/i, (whole, host) => `https://${host.toLowerCase()}`);
}

/**
 * The OSV query for one dependency record, or null when it identifies nothing queryable.
 * @implements RV-NATIVE-DEPS-02
 */
export function osvQuery(dependency) {
  if (dependency.unresolved) return null;
  if (dependency.kind === "conan") {
    return { package: { name: dependency.name, ecosystem: "ConanCenter" }, version: dependency.version };
  }
  if (dependency.revision && COMMIT.test(dependency.revision)) return { commit: dependency.revision.toLowerCase() };
  if (dependency.repository && dependency.revision) {
    return { package: { name: canonicalRepository(dependency.repository), ecosystem: "GIT" }, version: dependency.revision };
  }
  return null;
}

async function postBatch(queries, fetchImpl) {
  const response = await fetchImpl(OSV_QUERYBATCH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ queries }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`OSV querybatch answered ${response.status}`);
  const json = await response.json();
  if (!Array.isArray(json?.results) || json.results.length !== queries.length) {
    throw new Error("OSV querybatch returned a malformed result list");
  }
  return json.results;
}

/**
 * Vulnerability ids per query, in query order. Any transport or shape failure
 * throws: the caller decides whether an unanswered query blocks.
 * @implements RV-NATIVE-DEPS-02
 */
export async function queryOsv(queries, { fetchImpl = fetch } = {}) {
  const answers = [];
  for (let start = 0; start < queries.length; start += BATCH_LIMIT) {
    const results = await postBatch(queries.slice(start, start + BATCH_LIMIT), fetchImpl);
    for (const result of results) {
      const vulns = Array.isArray(result?.vulns) ? result.vulns : [];
      answers.push(vulns.map((vuln) => vuln?.id).filter((id) => typeof id === "string").sort());
    }
  }
  return answers;
}
