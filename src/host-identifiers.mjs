import { contract } from './contract-runtime.mjs'; /* augur-inject:import:13dc0166 */
import augurContract_7f76138a from '../contracts/contains-private-ip.contract.mjs'; /* augur-inject:contract-predicate:2b172dcf */
import augurContract_f1715103 from '../contracts/contains-local-path.contract.mjs'; /* augur-inject:contract-predicate:c98455f4 */
/**
 * ホストを特定できる記述 (LAN / Tailscale の IP、 PC のフルパス) を 1 行から見つける組込み検出器。
 *
 * 2026-10-13、 公開リポジトリの手順書に Windows 機 / Mac のホスト名・LAN IP・Tailscale IP・
 * SSH ユーザ名が書かれたまま公開されかけた。 秘密鍵・トークンと辞書の固定語しか見ない検査は
 * これを素通りする。 IP とパスは「形」で分かるので、 辞書に正規表現を書かせず組込みで持つ
 * (辞書に正規表現を書かせると、 誤った式が黙って検査を無効にする)。
 *
 * 検出器は「当たったか」だけを返す。 値そのものは呼び出し元へ渡さない — 所見は種類・場所だけに
 * 限るので、 値を返す口を作らないのが一番漏れない。
 *
 * AIFormat の leak-checker (`scripts/leak-checker/host-identifiers.mjs`) が同じ規則を持つ。
 * 規則を変えるときは両方を揃える。
 */

/** 組込み検出器の種類。 */
export const BUILTIN_DETECTOR_KINDS = Object.freeze(["private-ip", "local-path"]);
/** 辞書の keywords に `category` で付ける固定語の種類。 */
export const KEYWORD_CATEGORY_KINDS = Object.freeze(["machine-name", "site-name"]);
/** 種類ごとの扱い。 新しい種類の既定は advisory。 */
export const CATEGORY_MODES = Object.freeze(["advisory", "enforce", "off"]);
export const DEFAULT_CATEGORY_MODE = "advisory";

const IPV4 = /(?<![\w.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\w|\.\d|\/\d)/g;

function isPrivateHostAddress(octets) {
  if (octets.some((octet) => octet > 255)) return false;
  const [a, b, , d] = octets;
  // 末尾 .0 / .255 はネットワーク・ブロードキャストの表記で、 具体的なホストではない。
  if (d === 0 || d === 255) return false;
  if (a === 10) return true;
  if (a === 172) return b >= 16 && b <= 31;
  if (a === 192) return b === 168;
  if (a === 100) return b >= 64 && b <= 127; // Tailscale (CGNAT)
  if (a === 169) return b === 254;
  // 127/8・0.0.0.0・文書用範囲 (192.0.2/24 等) と公開アドレスは対象外。
  return false;
}

/**
 * private / Tailscale / link-local の具体的なホストアドレスを含むか。
 * `/24` のような CIDR 表記は範囲の説明なので対象外。
 * @param {string} line
 * @returns {boolean}
 */
export function containsPrivateIp(line) {
  if (typeof line !== "string" || line.length < 7) return false;
  for (const match of line.matchAll(IPV4)) {
    if (isPrivateHostAddress(match.slice(1, 5).map(Number))) return true;
  }
  return false;
}
// @ts-expect-error augur-inject
containsPrivateIp = contract(containsPrivateIp, { ...augurContract_7f76138a, contractId: 'C-12', mode: 'observe', sample: 1, where: 'src/host-identifiers.mjs:46', rule: 'contract-wrap', id: '7f76138a' }); /* augur-inject:contract-wrap:7f76138a */

const PATH_SEGMENT = String.raw`[^\\/\s"'\x60<>|*?:;,()\[\]]*`;
const DRIVE_PATH = new RegExp(
  String.raw`(?<![A-Za-z0-9_])[A-Za-z]:(?:\\{1,2}|/)+(${PATH_SEGMENT})(?:(?:\\{1,2}|/)+(${PATH_SEGMENT}))?`,
  "g",
);
const POSIX_HOME = /(?<![\w.~\-/])\/(Users|home)\/([^/\s"'`<>]*)\//g;

/** プレースホルダ (`<name>`、 `${VAR}`、 `%VAR%`、 `{name}`) で始まる区切りは実在のパスではない。 */
function isPlaceholderSegment(segment) {
  return !segment || /^[<$%{]/.test(segment);
}

function hasConcreteDrivePath(line) {
  for (const match of line.matchAll(DRIVE_PATH)) {
    const [, first = "", second] = match;
    if (isPlaceholderSegment(first)) continue;
    // `C:\Users\<name>` は名前の部分が実在かどうかで判断する。
    if (first.toLowerCase() === "users" && isPlaceholderSegment(second ?? "")) continue;
    return true;
  }
  return false;
}

function hasConcreteHomePath(line) {
  for (const match of line.matchAll(POSIX_HOME)) {
    if (!isPlaceholderSegment(match[2])) return true;
  }
  return false;
}

/**
 * PC のフルパスを含むか。 Windows のドライブ絶対パス、 `/Users/<名前>/`、 `/home/<名前>/`。
 * プレースホルダ・`${VAR}`・`%VAR%`・`~` 始まりは対象外。
 * @param {string} line
 * @returns {boolean}
 */
export function containsLocalPath(line) {
  if (typeof line !== "string" || line.length < 3) return false;
  return hasConcreteDrivePath(line) || hasConcreteHomePath(line);
}
// @ts-expect-error augur-inject
containsLocalPath = contract(containsLocalPath, { ...augurContract_f1715103, contractId: 'C-13', mode: 'observe', sample: 1, where: 'src/host-identifiers.mjs:90', rule: 'contract-wrap', id: 'f1715103' }); /* augur-inject:contract-wrap:f1715103 */

const FULL_DRIVE_PATH = new RegExp(
  String.raw`(?<![A-Za-z0-9_])[A-Za-z]:(?:(?:\\{1,2}|/)+${PATH_SEGMENT})*`,
  "g",
);
const FULL_HOME_PATH = /(?<![\w.~\-/])\/(?:Users|home)\/[^/\s"'`<>]*(?:\/[^/\s"'`<>|*?:;,()[\]]*)*/g;

/** 区切りを `/` にそろえ、 重複・末尾の区切りを落として小文字にする。 */
function normalizePathForRoot(path) {
  return path.replace(/\\+/g, "/").replace(/\/+/g, "/").replace(/\/$/, "").toLowerCase();
}

/**
 * 語ファイルの `workspaceRoots` を検証して正規化する。 書かれていなければ空 (除外しない)。
 * ルートは PC のフルパスそのものなので、 リポジトリに置かず語ファイルからだけ受け取る。
 * 崩れた宣言は黙って捨てず読込失敗にする。
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeWorkspaceRoots(raw) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("Confidential term workspaceRoots must be an array.");
  return raw.map((value) => {
    const root = typeof value === "string" ? normalizePathForRoot(value.trim()) : "";
    // ドライブ直下や `/` 直下の 1 段をルートにすると、 ほとんどのパスが除外される。
    if (!/^[a-z]:\/[^/]/.test(root) && !/^\/[^/]+\/[^/]/.test(root)) {
      throw new Error("Confidential term workspaceRoots lists an invalid root.");
    }
    return root;
  });
}

function isUnderRoot(path, roots) {
  const normalized = normalizePathForRoot(path);
  return roots.some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

/**
 * 行の中の具体的な PC のフルパスが 1 つ以上あり、 そのすべてがワークスペースルート配下か。
 *
 * 定義は 2026-10-13 の公開リポ監査 (local-path 195,848 件の内訳を出した集計) と同じ
 * 「行内のドライブパスがすべてワークスペースルート配下」。 ルート配下のパスはリポジトリの
 * 並び (公開リポ名と同じ情報) しか持たない一方、 ルート外のパス (ホーム・別ドライブ) は
 * 利用者名や機材の構成を表す。 監査はドライブパスだけを数えたが、 ここでは `/Users/<名前>/`
 * 等も「ルート外のパス」として数える — 同じ行にあるホームのパスまで一緒に除外しないため。
 * 値は返さない。
 * @param {string} line
 * @param {string[]} roots normalizeWorkspaceRoots の結果
 * @returns {boolean}
 */
export function localPathsAllUnderRoots(line, roots) {
  if (typeof line !== "string" || !Array.isArray(roots) || roots.length === 0) return false;
  let concrete = 0;
  for (const [path] of line.matchAll(FULL_DRIVE_PATH)) {
    if (!hasConcreteDrivePath(path)) continue;
    if (!isUnderRoot(path, roots)) return false;
    concrete += 1;
  }
  for (const [path] of line.matchAll(FULL_HOME_PATH)) {
    if (!hasConcreteHomePath(`${path}/`)) continue;
    if (!isUnderRoot(path, roots)) return false;
    concrete += 1;
  }
  return concrete > 0;
}

const DETECTOR_TESTS = Object.freeze({
  "private-ip": containsPrivateIp,
  "local-path": containsLocalPath,
});

/**
 * 有効な組込み検出器を返す。 `off` の種類は外す。
 * @param {Record<string, string>} categoryModes
 * @returns {{ id: string, kind: string, test: (line: string) => boolean }[]}
 */
export function enabledBuiltinDetectors(categoryModes = {}) {
  return BUILTIN_DETECTOR_KINDS
    .filter((kind) => (categoryModes[kind] ?? DEFAULT_CATEGORY_MODE) !== "off")
    .map((kind) => ({ id: kind, kind, test: DETECTOR_TESTS[kind] }));
}

/**
 * 辞書の `categories` を検証して種類ごとの扱いを返す。 書かれていない種類は advisory。
 * 知らない種類・扱いは黙って捨てず読込失敗にする (綴り違いで検査が消えないように)。
 * @param {unknown} raw
 * @returns {Record<string, string>}
 */
export function normalizeCategoryModes(raw) {
  const modes = Object.fromEntries(
    [...BUILTIN_DETECTOR_KINDS, ...KEYWORD_CATEGORY_KINDS].map((kind) => [kind, DEFAULT_CATEGORY_MODE]),
  );
  if (raw === undefined) return modes;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Confidential term categories must be an object.");
  }
  for (const [kind, value] of Object.entries(raw)) {
    if (!(kind in modes)) throw new Error("Confidential term categories lists an unknown category.");
    const mode = typeof value === "string" ? value : value?.mode;
    if (!CATEGORY_MODES.includes(mode)) {
      throw new Error("Confidential term category mode must be advisory, enforce, or off.");
    }
    modes[kind] = mode;
  }
  return modes;
}
