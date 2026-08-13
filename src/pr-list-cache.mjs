export class PrListCache {
  #version = null;
  #settingsKey = null;
  #value = null;

  // Returned arrays and their records are shared. Callers that mutate them must copy first.
  /** @implements SPEC-PR-LIST-CACHE */
  read({ version, settingsKey, build }) {
    if (version !== null && version === this.#version && settingsKey === this.#settingsKey) {
      return this.#value;
    }
    const value = build();
    if (version !== null) {
      this.#version = version;
      this.#settingsKey = settingsKey;
      this.#value = value;
    }
    return value;
  }
}

/** @implements SPEC-PR-LIST-CACHE */
export function decisionSettingsKey(settings) {
  return JSON.stringify([
    settings?.autoMergeEnabled ?? false,
    settings?.autoMergeRiskThreshold ?? null,
    settings?.autoMergeRequiresRuntimeVerificationClear ?? null,
  ]);
}

export function summaryProjection(pullRequest) {
  return {
    id: pullRequest.id,
    number: pullRequest.number,
    repository: pullRequest.repository,
    title: pullRequest.title,
    status: pullRequest.status,
    checkStatus: pullRequest.checkStatus,
    reviewLane: pullRequest.reviewLane ?? null,
    createdAt: pullRequest.createdAt,
    updatedAt: pullRequest.updatedAt,
    decision: pullRequest.decision,
  };
}

export class ListResponseCache {
  #source = null;
  #bodies = new Map();

  /** @implements SPEC-PR-LIST-CACHE */
  render(source, key, build) {
    if (this.#source !== source) {
      this.#bodies.clear();
      this.#source = source;
    }
    if (!this.#bodies.has(key)) this.#bodies.set(key, build());
    return this.#bodies.get(key);
  }
}

export const LIST_STATES = new Set(["open", "merged", "closed", "all"]);

export function filterByState(pullRequests, state) {
  if (state === "all") return pullRequests;
  return pullRequests.filter((pullRequest) => pullRequest.status === state);
}

export function listResponseBody(pullRequests, { view, state }) {
  const filtered = filterByState(pullRequests, state);
  const projected = view === "summary" ? filtered.map(summaryProjection) : filtered;
  return JSON.stringify({ pullRequests: projected });
}
