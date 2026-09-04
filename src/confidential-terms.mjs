import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";

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
 * ## 既定は advisory
 *
 * 顧客名や組織名が**識別子として機能している**箇所が実在する (関数名・ファイル名・
 * 稼働中の API パス)。 いきなり block にすると、それらを触る PR が一斉に通らなくなる。
 * まず見えるようにして、リポジトリごとに許可を積んでから enforced へ上げる
 * (Anatomia の二層ゲートと同じ順序)。
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
    entries.push({ candidateId: typeof id === "string" ? id.trim() : null, value: value.trim().toLowerCase() });
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
  const terms = entries.map(({ candidateId, value }) => {
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
    return { id: label, value };
  });
  // 長い語を先に出し、包含関係にある語の所見を読みやすい順序に保つ。
  return terms.sort((left, right) => right.value.length - left.value.length);
}

/** @implements SPEC-CONFIDENTIAL-TERM-ADVISORY */
export function loadConfidentialTerms(path) {
  if (!path) return null;
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
  let parsed;
  try {
    parsed = JSON.parse(contents);
  } catch {
    // Recent JSON parser errors can quote source fragments, which may be confidential terms.
    throw new Error("The confidential terms file is not valid JSON.");
  }
  const terms = normalizeTerms(parsed);
  if (terms.length === 0) {
    throw new Error("The confidential terms file must contain at least one valid keyword.");
  }
  return terms;
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
export function scanAddedDiffForConfidentialTerms(unifiedDiff, terms, { changedPaths = [] } = {}) {
  if (!Array.isArray(terms) || terms.length === 0) {
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
  const add = (termId, findingPath, line, shouldRedactPath = false) => {
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
      };
    }
  };

  /** @implements SPEC-CONFIDENTIAL-TERM-ADVISORY */
  const scanPath = (candidatePath) => {
    if (typeof candidatePath !== "string" || !candidatePath) return;
    const lowerPath = candidatePath.toLowerCase();
    for (const term of terms) {
      if (lowerPath.includes(term.value)) add(term.id, candidatePath, 0, true);
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
      const lower = diffLine.slice(1).toLowerCase();
      // A path that could not be decoded must not make the content scan fail
      // open. Keep a non-sensitive location marker instead.
      const findingPath = path ?? "[unparsed-diff-path]";
      const unsafePath = /[\u0000-\u001f\u007f]/.test(findingPath);
      for (const term of terms) {
        if (lower.includes(term.value)) {
          add(term.id, findingPath, addedLine, redactedPaths.has(findingPath) || unsafePath);
        }
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
    + ` (${shown}${totalFiles > Math.min(paths.length, 5) ? ", ..." : ""})`;
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
    return "公開できない語の検査を実行できませんでした。設定を確認してください。";
  }
}
