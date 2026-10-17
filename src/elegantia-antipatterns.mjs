import { resolveServiceLoopbackUrl } from "./catalog.mjs";
import { contract } from './contract-runtime.mjs'; /* augur-inject:import:a4ff30d5 */
import augurContract_096d6b39 from '../contracts/fetch-elegantia-antipatterns.contract.mjs'; /* augur-inject:contract-predicate:8bdd167d */

const DEFAULT_TIMEOUT_MS = 1_500;
// A fresh catalog is reused for this long so a burst of reviews does not wait
// on Elegantia once per review. A stale entry is still the fallback after it.
const DEFAULT_FRESH_MS = 5 * 60_000;
const MAX_ITEMS = 40;
const MAX_TEXT_LENGTH = 600;
const MAX_DETECT = 8;
const ANTIPATTERN_ID = /^AP[0-9A-Za-z-]{1,40}$/;

// Last successful catalog per Elegantia base URL (process lifetime). The
// catalog is public read-only data, so keeping it in memory leaks nothing.
const defaultCache = new Map();

function boundedText(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, MAX_TEXT_LENGTH) : null;
}

/**
 * Keeps only the fields a reviewer needs. An item without an id, title,
 * detection hints or fix is dropped and counted, never silently.
 */
export function normalizeAntipattern(value) {
  if (!value || typeof value !== "object") return null;
  const id = typeof value.id === "string" ? value.id.trim() : "";
  const title = boundedText(value.title);
  const fix = boundedText(value.fix);
  const detect = Array.isArray(value.detect)
    ? value.detect.map(boundedText).filter(Boolean).slice(0, MAX_DETECT)
    : [];
  if (!ANTIPATTERN_ID.test(id) || !title || !fix || detect.length === 0) return null;
  return { id, title, detect, fix };
}

function unavailable(reason, cached, now) {
  if (cached) {
    return {
      status: "stale",
      items: cached.items,
      skipped: cached.skipped,
      fetchedAt: cached.fetchedAt,
      reason,
      checkedAt: now,
    };
  }
  return { status: "unavailable", items: [], skipped: 0, fetchedAt: null, reason, checkedAt: now };
}

async function requestCatalog({ baseUrl, fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(new URL("/api/antipatterns", baseUrl), {
        method: "GET",
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`timed out after ${timeoutMs}ms`, { cause: error });
      throw new Error("request failed", { cause: error });
    }
    if (!response?.ok) throw new Error(`HTTP ${response?.status ?? "unknown"}`);
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.items)) throw new Error("invalid response");
    return payload.items;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Elegantia の anti-pattern catalog を審査観点として取得する。 失敗しても例外は投げず、
 * status (`fetched` / `cached` / `stale` / `unavailable`) と理由を返す。 呼び出し側は
 * `stale` / `unavailable` を「取得失敗」として審査レポートに明示する。
 * @implements SPEC-ELEGANTIA-ANTIPATTERN-REVIEW
 */
export async function fetchElegantiaAntipatterns({
  cwd,
  fetchImpl = fetch,
  baseUrl = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  freshMs = DEFAULT_FRESH_MS,
  cache = defaultCache,
  clock = () => Date.now(),
} = {}) {
  const now = new Date(clock()).toISOString();
  let url = baseUrl;
  if (!url) {
    try {
      url = resolveServiceLoopbackUrl(cwd, "elegantia");
    } catch (error) {
      return unavailable(`port resolution failed: ${error.message}`, null, now);
    }
  }
  const cached = cache.get(url) ?? null;
  if (cached && clock() - cached.storedAt < freshMs) {
    return { status: "cached", items: cached.items, skipped: cached.skipped, fetchedAt: cached.fetchedAt, reason: null, checkedAt: now };
  }
  if (typeof fetchImpl !== "function") return unavailable("fetch is unavailable", cached, now);
  let raw;
  try {
    raw = await requestCatalog({ baseUrl: url, fetchImpl, timeoutMs });
  } catch (error) {
    return unavailable(error.message, cached, now);
  }
  const normalized = raw.map(normalizeAntipattern);
  const items = normalized.filter(Boolean).slice(0, MAX_ITEMS);
  const skipped = raw.length - items.length;
  cache.set(url, { items, skipped, fetchedAt: now, storedAt: clock() });
  return { status: "fetched", items, skipped, fetchedAt: now, reason: null, checkedAt: now };
}
// @ts-expect-error augur-inject
fetchElegantiaAntipatterns = contract(fetchElegantiaAntipatterns, { ...augurContract_096d6b39, contractId: 'C-16', mode: 'observe', sample: 1, where: 'src/elegantia-antipatterns.mjs:80', rule: 'contract-wrap', id: '096d6b39' }); /* augur-inject:contract-wrap:096d6b39 */
