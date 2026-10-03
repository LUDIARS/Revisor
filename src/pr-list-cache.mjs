import { contract } from './contract-runtime.mjs'; /* augur-inject:import:7b4e67fc */
import augurContract_bd3da953 from '../contracts/list-response-body-without-review-report.contract.mjs'; /* augur-inject:contract-predicate:f5a553e6 */
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
    headSha: pullRequest.headSha,
    // 進捗記録は検査ごとの出力を持ち、この PR で登録チェック単位の記録が増えた。
    // 板の一覧カードは詳細の有無だけ分かればよいので版だけを返し、全文は
    // 詳細 (`/v1/local-prs/:id`) が返す (`view=full` の一覧は既定で外す)。
    reviewReportVersion: reviewReportVersionOf(pullRequest),
    // 決着済み PR の終局投稿 (Concordia Test Forum) がマージ先を示すのに使う。
    mergeCommitSha: pullRequest.mergeCommitSha ?? null,
    externalVerification: pullRequest.externalVerification ?? null,
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

export const LIST_INCLUDES = new Set(["reviewReport"]);

/**
 * `include` クエリ (複数指定・カンマ区切り可) を解釈する。未知の値は null を返し、
 * 呼び出し側が 400 にする。
 */
export function parseListIncludes(values) {
  const names = values.flatMap((value) => value.split(",")).map((name) => name.trim()).filter(Boolean);
  if (!names.every((name) => LIST_INCLUDES.has(name))) return null;
  return { includeReviewReport: names.includes("reviewReport") };
}

// 審査レポート本文は全件で一覧応答の 9 割超を占め (2026-10-02 実測 277 MB / 290 MB)、
// 一覧の取得をタイムアウトさせていた。full 一覧からは本文を外して版だけを残し、
// 本文は PR 単位の詳細 (`/v1/local-prs/:id`) から取る。
export function fullProjection(pullRequest) {
  const { reviewReport: _reviewReport, ...rest } = pullRequest;
  return { ...rest, reviewReportVersion: reviewReportVersionOf(pullRequest) };
}

// 一覧の記録は本文を持たず版だけを持つ (state store が本文を別テーブルへ分けた)。
// 本文付きの記録 (詳細・テストの手組み) も同じ版を返せるよう、 両方を見る。
function reviewReportVersionOf(pullRequest) {
  return pullRequest.reviewReportVersion ?? pullRequest.reviewReport?.version ?? null;
}

/**
 * `include=reviewReport` の full 一覧。 本文は state store の別テーブルにあるので、
 * 絞り込んだ PR の分だけ `readReviewReports(ids)` で読んで付ける。
 */
function withReviewReports(pullRequests, readReviewReports) {
  const reports = readReviewReports(pullRequests.map((pullRequest) => pullRequest.id));
  return pullRequests.map((pullRequest) => {
    const { reviewReportVersion: _version, ...rest } = pullRequest;
    const reviewReport = reports.get(pullRequest.id) ?? pullRequest.reviewReport;
    return reviewReport === undefined ? rest : { ...rest, reviewReport };
  });
}

/** @implements SPEC-PR-LIST-CACHE */
export function listResponseBody(pullRequests, {
  view,
  state,
  includeReviewReport = false,
  readReviewReports = () => new Map(),
}) {
  const filtered = filterByState(pullRequests, state);
  let projected = filtered;
  if (view === "summary") projected = filtered.map(summaryProjection);
  else if (includeReviewReport) projected = withReviewReports(filtered, readReviewReports);
  else projected = filtered.map(fullProjection);
  return JSON.stringify({ pullRequests: projected });
}
// @ts-expect-error augur-inject
listResponseBody = contract(listResponseBody, { ...augurContract_bd3da953, contractId: 'C-11', mode: 'observe', sample: 1, where: 'src/pr-list-cache.mjs:97', rule: 'contract-wrap', id: 'bd3da953' }); /* augur-inject:contract-wrap:bd3da953 */
