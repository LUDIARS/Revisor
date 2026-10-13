import { localPathsAllUnderRoots } from "./host-identifiers.mjs";
import { contract } from './contract-runtime.mjs'; /* augur-inject:import:b80f0cbf */
import augurContract_1aa8b184 from '../contracts/excluded-host-finding.contract.mjs'; /* augur-inject:contract-predicate:544409c4 */

/**
 * 種類つきの流出所見 (private-ip / local-path / machine-name / site-name) のうち、
 * 数えない所見を決める除外ルール。 category の無い従来の語には使わない — 従来の語は
 * 未公開プロダクト名・顧客名で、 テストや生成物の中にあっても公開面に出るのは同じだから。
 *
 * 2026-10-13 の公開リポ監査 (273 checkout) で local-path 195,848 件・private-ip 1,368 件・
 * machine-name 461 件が出た。 内訳は生成レポート (`report/` 配下と html) とテストが大半で、
 * private-ip はテストを除くと 181 件、 machine-name は 450 件がテストだった。 neco の決定で
 * 次の 3 つを除外する:
 *
 * 1. 生成レポート — `report/` 配下、 `*.html` / `*.htm` / `*.html.json`。
 * 2. テスト — `test/`・`tests/`・`__tests__/`・`fixture/`・`fixtures/` 配下、 `*.test.*`・`*.spec.*`。
 *    テストの値は架空で、 検出器の境界を確かめるためにわざと「それらしい形」を書く。
 * 3. local-path の行で、 行内の具体的な PC のフルパスがすべてワークスペースルート配下のもの。
 *    定義は監査と同じ (`localPathsAllUnderRoots` のコメント参照)。 ルートは語ファイルの
 *    `workspaceRoots` から受け取り、 リポジトリには置かない。
 *
 * パス規則は監査の集計 (`(^|/)(tests?|__tests__|fixtures?)/`、 `\.(test|spec)\.[a-z]+$`) と同じ。
 * AIFormat の leak-checker (`scripts/leak-checker/leak-exclusions.mjs`) が同じ規則を持つ。
 * 規則を変えるときは両方を揃える。
 */

export const HOST_FINDING_KINDS = Object.freeze(["private-ip", "local-path", "machine-name", "site-name"]);

const GENERATED_REPORT_PATH = /(^|\/)report\/|\.html?$|\.html\.json$/i;
const TEST_PATH = /(^|\/)(tests?|__tests__|fixtures?)\//i;
const TEST_FILE = /\.(test|spec)\.[a-z0-9]+$/i;

function normalizeRepoPath(path) {
  return typeof path === "string" ? path.replace(/\\/g, "/") : "";
}

/** 生成レポートか (`report/` 配下・html)。 */
export function isGeneratedReportPath(path) {
  return GENERATED_REPORT_PATH.test(normalizeRepoPath(path));
}

/** テストのファイルか (テスト用ディレクトリ配下・`*.test.*`・`*.spec.*`・fixtures)。 */
export function isTestPath(path) {
  const normalized = normalizeRepoPath(path);
  return TEST_PATH.test(normalized) || TEST_FILE.test(normalized);
}

/**
 * この種類つき所見を数えないか。 従来の語 (`kind` 無し) は常に false。
 * パスの規則はどの種類にも、 ワークスペースルートの規則は local-path だけに使う。
 * @param {{ kind?: string | null, path?: string, lineText?: string }} finding
 * @param {{ workspaceRoots?: string[] }} [options]
 * @returns {boolean}
 */
export function isExcludedHostFinding(finding, { workspaceRoots = [] } = {}) {
  const kind = finding?.kind;
  if (!HOST_FINDING_KINDS.includes(kind)) return false;
  if (isGeneratedReportPath(finding.path) || isTestPath(finding.path)) return true;
  return kind === "local-path" && localPathsAllUnderRoots(finding.lineText ?? "", workspaceRoots);
}
// @ts-expect-error augur-inject
isExcludedHostFinding = contract(isExcludedHostFinding, { ...augurContract_1aa8b184, contractId: 'C-15', mode: 'observe', sample: 1, where: 'src/leak-exclusions.mjs:53', rule: 'contract-wrap', id: '1aa8b184' }); /* augur-inject:contract-wrap:1aa8b184 */
