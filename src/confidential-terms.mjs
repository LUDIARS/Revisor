import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  KEYWORD_CATEGORY_KINDS,
  enabledBuiltinDetectors,
  normalizeCategoryModes,
} from "./host-identifiers.mjs";
import { contract } from './contract-runtime.mjs'; /* augur-inject:import:bec15215 */
import augurContract_de234b47 from '../contracts/confidential-terms-outcome-by-kind.contract.mjs'; /* augur-inject:contract-predicate:fd2c6bb9 */

/**
 * 公開リポジトリへ入れてはいけない語 (未公開プロダクト名・顧客名・組織名) を
 * 追加差分から見つける。
 *
 * 2026-09-04 に実際に起きたことが根拠: 一度 neco 裁定で履歴ごと削除された
 * 未公開プロダクトの実装が、別ブランチの local PR として戻ってきた。 審査は通り、
 * マージリスクだけが偶然閾値を超えていたので止まっていた。 情報流出スキャン
 * (`leakage.mjs`) は資格情報しか見ないので、この面は素通りする。
 *
 * ## 値を持たない
 *
 * 語そのものはこのリポジトリに置かない。 **外部ファイル**から読む
 * (`REVISOR_CONFIDENTIAL_TERMS_FILE`)。 未設定なら検査そのものを行わない —
 * 語を同梱すると、流出を止める仕組みが流出源になる。
 *
 * 所見は安全化した id・パス・行番号だけで、値と一致した行の中身は載せない。
 * パス自体が一致した場合はパスも伏せる。 審査結果は PR 本文や通知へ流れるので、
 * そこに値を書けば二次的な流出になる。
 *
 * ## 既定は advisory、 語ファイルが enforcement を宣言したら block
 *
 * 顧客名や組織名が**識別子として機能している**箇所が実在する (関数名・ファイル名・
 * 稼働中の API パス)。 いきなり block にすると、それらを触る PR が一斉に通らなくなる。
 * まず見えるようにして、リポジトリごとに許可を積んでから enforced へ上げる
 * (Anatomia の二層ゲートと同じ順序)。
 *
 * 2026-09-15、 公開リポジトリへキャラクター名と素材パスが再流出していた。 advisory は
 * 設定されていても止めない。 語ファイルに `enforcement: { mode: "enforce-except",
 * exceptRepositories: [...] }` があれば、 例外に挙げたリポジトリ以外では審査の理由
 * (マージ不可) にし、 squash commit の件名・本文もマージ直前に検査する。
 * 例外 (= 語を正当に扱う非公開リポジトリ) の一覧も語ファイル側に置く — 公開される
 * catalog や設定に非公開リポジトリ名を書かないため。 新しい公開リポジトリは既定で守られる。
 *
 * ## 種類つきの検出 (2026-10-13)
 *
 * IP・PC のフルパス・マシン名・拠点名も同じ経路で見る。 IP とパスは組込みの検出器
 * (`host-identifiers.mjs`)、 マシン名・拠点名は keywords に `category` を付けた固定語。
 * 語ファイルの `categories: { "<種類>": "advisory" | "enforce" | "off" }` で種類ごとに扱いを
 * 選ぶ。 書かれていない種類は advisory。 category の無い従来の語は従来どおり
 * `enforcement` に従う。 enforce の種類も `exceptRepositories` の例外は共有する。
 */

const MAX_FINDINGS = 100;
const MAX_TERMS_FILE_BYTES = 1024 * 1024;
const SAFE_TERM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** @implements SPEC-CONFIDENTIAL-TERM-ADVISORY */
function normalizeTerms(raw) {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.keywords)) {
    throw new Error("Confidential terms file must be an object with a keywords array.");
  }
  const entries = [];
  for (const entry of raw.keywords) {
    const value = typeof entry === "string" ? entry : entry?.value;
    const id = typeof entry === "string" ? null : entry?.id;
    if (typeof value !== "string" || !value.trim()) continue;
    const category = typeof entry === "string" ? undefined : entry?.category;
    if (category !== undefined && !KEYWORD_CATEGORY_KINDS.includes(category)) {
      throw new Error("A confidential keyword declares an unknown category.");
    }
    entries.push({
      candidateId: typeof id === "string" ? id.trim() : null,
      value: value.trim().toLowerCase(),
      category: category ?? null,
    });
  }
  const confidentialValues = entries.map(({ value }) => value);
  const candidateCounts = new Map();
  for (const { candidateId } of entries) {
    if (candidateId) candidateCounts.set(candidateId, (candidateCounts.get(candidateId) ?? 0) + 1);
  }
  const reservedIds = new Set(entries
    .filter(({ candidateId }) => {
      const lowerId = candidateId?.toLowerCase() ?? "";
      return SAFE_TERM_ID.test(candidateId ?? "")
        && !confidentialValues.some((confidentialValue) => lowerId.includes(confidentialValue))
        && candidateCounts.get(candidateId) === 1;
    })
    .map(({ candidateId }) => candidateId));
  const usedIds = new Set();
  let nextFallbackIndex = 1;
  const terms = entries.map(({ candidateId, value, category }) => {
    // id 自体も永続化され得る。 制御文字や別の機密語を含む id は採用しない。
    const isSafeId = reservedIds.has(candidateId) && !usedIds.has(candidateId);
    let label = candidateId;
    if (!isSafeId) {
      do {
        label = `term:${nextFallbackIndex}`;
        nextFallbackIndex += 1;
      } while (reservedIds.has(label) || usedIds.has(label));
    }
    usedIds.add(label);
    return category ? { id: label, value, category } : { id: label, value };
  });
  // 長い語を先に出し、包含関係にある語の所見を読みやすい順序に保つ。
  return terms.sort((left, right) => right.value.length - left.value.length);
}

/** @implements SPEC-CONFIDENTIAL-TERM-ADVISORY */
function readTermsFile(path) {
  if (!isAbsolute(path) || path.startsWith("\\\\") || path.startsWith("//")) {
    throw new Error("The confidential terms file must use an absolute local path.");
  }
  let contents;
  try {
    if (statSync(path).size > MAX_TERMS_FILE_BYTES) {
      throw new Error("too-large");
    }
    contents = readFileSync(path, "utf8");
  } catch {
    // The path is local configuration and must not be copied into persisted advisories.
    throw new Error("Cannot read the confidential terms file.");
  }
  try {
    return JSON.parse(contents);
  } catch {
    // Recent JSON parser errors can quote source fragments, which may be confidential terms.
    throw new Error("The confidential terms file is not valid JSON.");
  }
}

const REPOSITORY_PATTERN = /^[a-z0-9._-]+\/(?:\*|[a-z0-9._-]+)$/;

/**
 * 語ファイルの enforcement。 宣言が無ければ advisory のまま (既存運用を壊さない)。
 * 宣言があるのに形が崩れていたら、 黙って advisory に落とさず読込失敗にする。
 * @implements SPEC-CONFIDENTIAL-TERM-ENFORCEMENT
 */
function normalizeEnforcement(raw) {
  if (raw.enforcement === undefined) return { mode: "advisory", exceptRepositories: [] };
  const { enforcement } = raw;
  if (
    !enforcement
    || typeof enforcement !== "object"
    || enforcement.mode !== "enforce-except"
    || !Array.isArray(enforcement.exceptRepositories)
  ) {
    throw new Error("Confidential term enforcement must declare mode enforce-except and exceptRepositories.");
  }
  const exceptRepositories = enforcement.exceptRepositories.map((value) =>
    typeof value === "string" ? value.trim().toLowerCase() : "");
  if (exceptRepositories.some((value) => !REPOSITORY_PATTERN.test(value))) {
    throw new Error("Confidential term enforcement lists an invalid repository pattern.");
  }
  return { mode: "enforce-except", exceptRepositories };
}

/** 語と enforcement をまとめて読む。 未設定なら null。
 * @implements SPEC-CONFIDENTIAL-TERM-ENFORCEMENT
 */
export function loadConfidentialPolicy(path) {
  if (!path) return null;
  const parsed = readTermsFile(path);
  const terms = normalizeTerms(parsed);
  if (terms.length === 0) {
    throw new Error("The confidential terms file must contain at least one valid keyword.");
  }
  return {
    terms,
    enforcement: normalizeEnforcement(parsed),
    categories: normalizeCategoryModes(parsed.categories),
  };
}

/** @implements SPEC-CONFIDENTIAL-TERM-ADVISORY */
export function loadConfidentialTerms(path) {
  return loadConfidentialPolicy(path)?.terms ?? null;
}

/**
 * このリポジトリで公開不可語を block するか。 リポジトリ名が分からないときは
 * 例外に当たると証明できないので block 側に倒す。
 * @implements SPEC-CONFIDENTIAL-TERM-ENFORCEMENT
 */
export function isConfidentialTermsEnforced(policy, repository) {
  if (policy?.enforcement?.mode !== "enforce-except") return false;
  return !isExceptedRepository(policy, repository);
}

/** リポジトリ名が分からないときは例外に当たると証明できないので false。
 * @implements SPEC-CONFIDENTIAL-TERM-ENFORCEMENT
 */
function isExceptedRepository(policy, repository) {
  const name = typeof repository === "string" ? repository.trim().toLowerCase() : "";
  if (!name) return false;
  return (policy?.enforcement?.exceptRepositories ?? []).some((pattern) =>
    pattern.endsWith("/*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern);
}

/**
 * 所見の種類ごとに block するか。 category の無い従来の語は `enforcement` に従う。
 * 種類つきは `categories` が enforce のときだけ、 例外リポジトリ以外で block する。
 * @implements SPEC-CONFIDENTIAL-TERM-CATEGORIES
 */
export function isConfidentialKindEnforced(policy, repository, kind) {
  if (!kind) return isConfidentialTermsEnforced(policy, repository);
  return policy?.categories?.[kind] === "enforce" && !isExceptedRepository(policy, repository);
}

/** 有効な語と組込み検出器。 `off` の種類は外す。
 * @implements SPEC-CONFIDENTIAL-TERM-CATEGORIES
 */
function activeMatchers(policy) {
  const categories = policy?.categories ?? {};
  return {
    terms: (policy?.terms ?? []).filter((term) => !term.category || categories[term.category] !== "off"),
    detectors: enabledBuiltinDetectors(categories),
  };
}

/** 設定された語ファイルの場所。 未設定なら検査しない。
 * @implements SPEC-CONFIDENTIAL-TERM-ADVISORY
 */
export function confidentialTermsPath(env = process.env) {
  const value = env.REVISOR_CONFIDENTIAL_TERMS_FILE;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** @implements SPEC-CONFIDENTIAL-TERM-ADVISORY */
function diffPath(raw) {
  if (raw === "/dev/null") return null;
  let value = raw;
  if (value.startsWith("\"")) {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value.startsWith("b/") ? value.slice(2) : value;
}

/**
 * 追加差分に出た語を返す。 既存行は見ない — その PR が**足した**分だけが、
 * その PR で止められる対象だから。 既に入っている分は別の作業 (履歴の掃除)。
 *
 * ファイルパス自体も見る。 `server/<取引先名>-user-client.ts` のように、名前だけで
 * 判る形が実在する。
 */
/** @implements SPEC-CONFIDENTIAL-TERM-ADVISORY */
export function scanAddedDiffForConfidentialTerms(
  unifiedDiff,
  terms,
  { changedPaths = [], detectors = [] } = {},
) {
  const hasTerms = Array.isArray(terms) && terms.length > 0;
  const hasDetectors = Array.isArray(detectors) && detectors.length > 0;
  if (!hasTerms && !hasDetectors) {
    return { findings: [], totalFindings: 0, totalFiles: 0, truncated: false, scanned: false };
  }
  if (typeof unifiedDiff !== "string") {
    throw new TypeError("Confidential term scan requires a unified diff string.");
  }
  const findings = [];
  const seen = new Set();
  const matchedPaths = new Set();
  const redactedPaths = new Map();
  let total = 0;
  let path = null;
  let addedLine = 0;
  let inHunk = false;

  /** @implements SPEC-CONFIDENTIAL-TERM-ADVISORY */
  const add = (termId, findingPath, line, shouldRedactPath = false, kind = null) => {
    const key = `${termId}\u0000${findingPath}\u0000${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    matchedPaths.add(findingPath);
    total += 1;
    if (findings.length < MAX_FINDINGS) {
      if (shouldRedactPath && !redactedPaths.has(findingPath)) {
        redactedPaths.set(findingPath, `[redacted-path:${redactedPaths.size + 1}]`);
      }
      findings[findings.length] = {
        termId,
        path: redactedPaths.get(findingPath) ?? findingPath,
        line,
        ...(kind ? { kind } : {}),
      };
    }
  };

  /** @implements SPEC-CONFIDENTIAL-TERM-ADVISORY */
  const scanPath = (candidatePath) => {
    if (typeof candidatePath !== "string" || !candidatePath) return;
    const lowerPath = candidatePath.toLowerCase();
    for (const term of hasTerms ? terms : []) {
      if (lowerPath.includes(term.value)) add(term.id, candidatePath, 0, true, term.category);
    }
  };

  // `git diff --name-only -z` supplies raw paths even when a binary patch has no
  // +++ header or Git C-quotes a non-ASCII path in the textual diff.
  if (Array.isArray(changedPaths)) {
    for (const changedPath of changedPaths) scanPath(changedPath);
  }

  for (const diffLine of unifiedDiff.split(/\r?\n/)) {
    if (diffLine.startsWith("diff --git ")) {
      path = null;
      inHunk = false;
      continue;
    }
    // Inside a hunk, `+++ text` is an added source line whose content starts
    // with `++`; it is not a file header.
    if (!inHunk && diffLine.startsWith("+++ ")) {
      path = diffPath(diffLine.slice(4));
      scanPath(path);
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(diffLine);
    if (hunk) {
      addedLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || diffLine.startsWith("\\ No newline")) continue;
    if (diffLine.startsWith("+")) {
      const content = diffLine.slice(1);
      const lower = content.toLowerCase();
      // A path that could not be decoded must not make the content scan fail
      // open. Keep a non-sensitive location marker instead.
      const findingPath = path ?? "[unparsed-diff-path]";
      const unsafePath = /[\u0000-\u001f\u007f]/.test(findingPath);
      const redact = redactedPaths.has(findingPath) || unsafePath;
      for (const term of hasTerms ? terms : []) {
        if (lower.includes(term.value)) add(term.id, findingPath, addedLine, redact, term.category);
      }
      // 組込み検出器は本文だけを見る。 パスはリポジトリ相対なので IP・フルパスの形にならない。
      for (const detector of hasDetectors ? detectors : []) {
        if (detector.test(content)) add(detector.id, findingPath, addedLine, redact, detector.kind);
      }
      addedLine += 1;
      continue;
    }
    if (!diffLine.startsWith("-")) addedLine += 1;
  }

  return {
    findings,
    totalFindings: total,
    totalFiles: matchedPaths.size,
    truncated: total > findings.length,
    scanned: true,
  };
}

/** 審査結果へ載せる 1 行。 語も一致行の中身も出さない。
 * @implements SPEC-CONFIDENTIAL-TERM-ADVISORY
 */
export function confidentialTermsAdvisory(result) {
  if (!result?.scanned || result.totalFindings === 0) return null;
  const paths = [...new Set(result.findings.map((finding) => finding.path))];
  const shown = paths.slice(0, 5).join(", ");
  const totalFiles = Number.isInteger(result.totalFiles) ? result.totalFiles : paths.length;
  return `公開できない語を含む追加差分: ${result.totalFindings} 箇所 / ${totalFiles} ファイル`
    + ` (${shown}${totalFiles > Math.min(paths.length, 5) ? ", ..." : ""})`
    + kindBreakdown(result.findings);
}

/**
 * 種類つきの所見があるときだけ種類別の件数を足す。 従来の語だけなら文言は変えない。
 * 種類名は固定の語彙 (private-ip 等) なので、 値を含まない。
 * @implements SPEC-CONFIDENTIAL-TERM-CATEGORIES
 */
function kindBreakdown(findings) {
  const counts = new Map();
  for (const finding of findings) {
    if (finding.kind) counts.set(finding.kind, (counts.get(finding.kind) ?? 0) + 1);
  }
  if (counts.size === 0) return "";
  const categorized = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const parts = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => `${kind} ${count}`);
  if (findings.length > categorized) parts.unshift(`語 ${findings.length - categorized}`);
  return ` [種類: ${parts.join(", ")}]`;
}

/** 設定の読込失敗を含め、永続化してよい advisory だけを返す。
 * @implements SPEC-CONFIDENTIAL-TERM-ADVISORY
 */
export function configuredConfidentialTermsAdvisory({
  unifiedDiff,
  changedPaths = [],
  env = process.env,
}) {
  try {
    const terms = loadConfidentialTerms(confidentialTermsPath(env));
    if (!terms || typeof unifiedDiff !== "string") return null;
    return confidentialTermsAdvisory(
      scanAddedDiffForConfidentialTerms(unifiedDiff, terms, { changedPaths }),
    );
  } catch {
    // Configuration paths and parser diagnostics can themselves disclose private data.
    return CONFIGURATION_FAILURE;
  }
}

const CONFIGURATION_FAILURE = "公開できない語の検査を実行できませんでした。設定を確認してください。";

/**
 * PR の件名・本文のような 1 本の文字列を検査する。 squash commit の本文になるので、
 * 追加差分と同じ扱いで公開面に出る。 所見の場所は固定ラベルと行番号だけ。
 * @implements SPEC-CONFIDENTIAL-TERM-ENFORCEMENT
 */
export function scanTextForConfidentialTerms(text, terms, label, detectors = []) {
  if (typeof text !== "string" || !text || !Array.isArray(terms)) return [];
  const findings = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const lower = line.toLowerCase();
    for (const term of terms) {
      if (!lower.includes(term.value)) continue;
      findings.push({
        termId: term.id, path: label, line: index + 1, ...(term.category ? { kind: term.category } : {}),
      });
    }
    for (const detector of detectors) {
      if (detector.test(line)) findings.push({ termId: detector.id, path: label, line: index + 1, kind: detector.kind });
    }
  });
  return findings;
}

/** @implements SPEC-CONFIDENTIAL-TERM-ENFORCEMENT */
function pullRequestTextFindings(pullRequest, terms, detectors = []) {
  return [
    ...scanTextForConfidentialTerms(pullRequest?.title, terms, "[pr-title]", detectors),
    ...scanTextForConfidentialTerms(pullRequest?.body, terms, "[pr-body]", detectors),
  ];
}

/**
 * 審査結果へ載せる所見。 enforced なリポジトリでは `reason` (マージ不可)、 それ以外は
 * `advisory`。 設定があるのに読めない場合は、 例外に当たるか判定できないので block する
 * (無言で素通りさせない)。 どちらの文にも語と一致行の中身は載せない。
 * @implements SPEC-CONFIDENTIAL-TERM-ENFORCEMENT
 */
export function configuredConfidentialTermsOutcome({
  unifiedDiff,
  changedPaths = [],
  pullRequest = null,
  repository = null,
  env = process.env,
}) {
  let policy;
  try {
    policy = loadConfidentialPolicy(confidentialTermsPath(env));
  } catch {
    return { advisory: null, reason: CONFIGURATION_FAILURE };
  }
  if (!policy || typeof unifiedDiff !== "string") return { advisory: null, reason: null };
  const { terms, detectors } = activeMatchers(policy);
  const diffResult = scanAddedDiffForConfidentialTerms(unifiedDiff, terms, { changedPaths, detectors });
  const textFindings = pullRequestTextFindings(pullRequest, terms, detectors);
  const enforced = newFindingGroup();
  const advisory = newFindingGroup();
  for (const finding of [...diffResult.findings, ...textFindings]) {
    addToGroup(isConfidentialKindEnforced(policy, repository, finding.kind) ? enforced : advisory, finding);
  }
  // 件数上限で落ちた差分所見は種類が分からない。 従来の語として数え、 従来の enforcement に
  // 従わせる (黙って advisory に倒さない)。
  const dropped = diffResult.totalFindings - diffResult.findings.length;
  if (dropped > 0) (isConfidentialTermsEnforced(policy, repository) ? enforced : advisory).total += dropped;
  const blocked = summarizeGroup(enforced);
  return {
    advisory: summarizeGroup(advisory),
    reason: blocked ? `${blocked} — 公開できない語を消してから再提出してください` : null,
  };
}
// @ts-expect-error augur-inject
configuredConfidentialTermsOutcome = contract(configuredConfidentialTermsOutcome, { ...augurContract_de234b47, contractId: 'C-14', mode: 'observe', sample: 1, where: 'src/confidential-terms.mjs:443', rule: 'contract-wrap', id: 'de234b47' }); /* augur-inject:contract-wrap:de234b47 */

/** @implements SPEC-CONFIDENTIAL-TERM-CATEGORIES */
function newFindingGroup() {
  return { findings: [], total: 0, labels: new Set() };
}

/** @implements SPEC-CONFIDENTIAL-TERM-CATEGORIES */
function addToGroup(group, finding) {
  if (group.findings.length < MAX_FINDINGS) group.findings.push(finding);
  group.total += 1;
  group.labels.add(finding.path);
}

/** @implements SPEC-CONFIDENTIAL-TERM-CATEGORIES */
function summarizeGroup(group) {
  return confidentialTermsAdvisory({
    scanned: true,
    findings: group.findings,
    totalFindings: group.total,
    totalFiles: group.labels.size,
  });
}

/**
 * squash commit の件名・本文を、 base を進める前に検査する。 審査の後に件名・本文が
 * 書き換えられても、 GitHub へ出るのはこの本文なので最後にもう一度見る。
 * 例外は term id だけを名指し、 語そのものは載せない。
 * @implements SPEC-CONFIDENTIAL-TERM-ENFORCEMENT
 */
export function assertCommitMessageFreeOfConfidentialTerms({ repository, title, body, env = process.env }) {
  let policy;
  try {
    policy = loadConfidentialPolicy(confidentialTermsPath(env));
  } catch {
    throw new Error("Merge blocked: the confidential term check could not run. Check its configuration.");
  }
  if (!policy) return;
  const { terms, detectors } = activeMatchers(policy);
  const findings = pullRequestTextFindings({ title, body }, terms, detectors)
    .filter((finding) => isConfidentialKindEnforced(policy, repository, finding.kind));
  if (findings.length === 0) return;
  const termIds = [...new Set(findings.map((finding) => finding.termId))].join(", ");
  throw new Error(
    `Merge blocked: the squash commit message contains ${findings.length} confidential term occurrence(s) `
    + `(${termIds}). Remove them from the local PR title and body, then merge again.`,
  );
}
