/**
 * `.revisor-version` をどのリポジトリで読み書きするかを決める。
 *
 * マージは Revisor 所有の隔離リポジトリで行うが (`merge-repository.mjs`)、
 * バージョンファイルの正本は**登録 checkout** 側にある。 リリース画面の状態表示
 * (`inspectLocalVersionState`) も初期化 (`initializeLocalVersion`) も登録 checkout を
 * 見るので、 公開だけが隔離リポジトリを見ると初期化した版数が永久に届かない。
 *
 * 実際に 2026-08-10 に発生した: Calicula / Ars / Interpres / Ludellus-Native を
 * 初期化した直後でも publish が `.revisor-version must be committed on the base branch`
 * で落ち続けた。 初期化コミットは登録 checkout にローカルで積まれる一方、 隔離
 * リポジトリの base は「初期化後は Revisor が所有し、 登録 checkout から更新しない」
 * 規約により決して前進しないため、 gate から見ると永久に未初期化だった。
 *
 * `prepareMergeRepository` が返す `registeredRootPath` はこの解決のためにある。
 */

/**
 * @param {{ rootPath: string, registeredRootPath?: string }} repository
 *   `prepareMergeRepository` を通した後の repository、 または登録 repository そのもの。
 * @returns {string} `.revisor-version` を読み書きするリポジトリのパス。
 */
export function resolveVersionRootPath(repository) {
  if (Object.hasOwn(repository ?? {}, "registeredRootPath")) {
    const registered = repository.registeredRootPath;
    if (typeof registered === "string" && registered.trim()) return registered;
    throw new TypeError("The registered repository root path must be a non-empty string.");
  }
  const rootPath = repository?.rootPath;
  if (typeof rootPath === "string" && rootPath.trim()) return rootPath;
  throw new TypeError("A repository with a root path is required to resolve the version file.");
}
