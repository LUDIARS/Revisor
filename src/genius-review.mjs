import { resolveServiceLoopbackUrl } from "./catalog.mjs";

const MAX_CARDS = 4;
const MAX_CARD_TEXT_LENGTH = 2_000;
const MAX_TAGS = 12;
const DEFAULT_TIMEOUT_MS = 2_000;

function boundedText(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Genius response has no valid ${field}.`);
  }
  return value.trim().slice(0, MAX_CARD_TEXT_LENGTH);
}

function publicCard(value) {
  if (!value || typeof value !== "object" || value.visibility !== "public") {
    throw new Error("Genius response included a non-public judgment card.");
  }
  if (!Number.isFinite(value.score)) {
    throw new Error("Genius response has no valid card score.");
  }
  return {
    category: value.category === null || typeof value.category === "string" ? value.category : null,
    situation: boundedText(value.situation, "card situation"),
    judgment: boundedText(value.judgment, "card judgment"),
    rationale: boundedText(value.rationale, "card rationale"),
    tags: Array.isArray(value.tags)
      ? value.tags.filter((tag) => typeof tag === "string").slice(0, MAX_TAGS)
      : [],
    confidence: Number.isFinite(value.confidence) ? value.confidence : 0,
    score: value.score,
  };
}

// The query deliberately contains only derived change metadata. A review diff,
// title, body, and session context are not needed to retrieve generic judgment
// cards and must not be copied into another service's query log.
export function geniusReviewQuery(classification) {
  return JSON.stringify({
    purpose: "local-pr-human-review",
    changeProfile: {
      kinds: classification.kinds,
      changedFiles: classification.changedFiles,
      changedLines: classification.changedLines,
      docsOnly: classification.docsOnly,
      docsOrConfigOnly: classification.docsOrConfigOnly,
      touchesSpec: classification.touchesSpec,
      touchesTests: classification.touchesTests,
      runtimeSurfaces: classification.runtimeSurfaces,
    },
  });
}

export async function queryGeniusReview({
  cwd,
  classification,
  fetchImpl = fetch,
  baseUrl = resolveServiceLoopbackUrl(cwd, "genius"),
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (typeof fetchImpl !== "function") throw new TypeError("Genius review requires fetch.");
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("Genius review timeout must be a positive integer.");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(new URL("/api/clone/query", baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: geniusReviewQuery(classification),
          domain: "work",
          visibility: "public",
          k: MAX_CARDS,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Genius review timed out after ${timeoutMs}ms.`, { cause: error });
      }
      throw new Error("Genius review request failed.", { cause: error });
    }
    if (!response?.ok) {
      throw new Error(`Genius review failed with HTTP ${response?.status ?? "unknown"}.`);
    }
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.cards) || !Number.isFinite(payload.tookMs)) {
      throw new Error("Genius review returned an invalid response.");
    }
    return {
      cards: payload.cards.slice(0, MAX_CARDS).map(publicCard),
      tookMs: payload.tookMs,
    };
  } finally {
    clearTimeout(timeout);
  }
}
