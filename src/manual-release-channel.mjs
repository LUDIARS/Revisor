import { RevisorError } from "./errors.mjs";
import { resolveRepositoryWorkflow, WORKFLOW_GITHUB } from "./repository-workflow.mjs";

/**
 * 手動 Release の「どこへ・何を出すか」の決定だけを持つ。
 *
 * - 公開経路はリポジトリの workflow に従う。 `revisor` は GitHub App で base + tag を
 *   atomic push し、 `github` は登録 checkout の資格情報で通常 push する。
 * - GitHub Release を作るかは操作者が選べる。 作らない場合も tag と local version は
 *   公開する (Release Notes の正本が無い版になるだけ)。
 * - GitHub Release の作成は App の API でしか行わない。 App を持たない `github`
 *   workflow で作成を求められたら、 黙って tag だけにせず明示的に断る。
 *
 * 未指定の既定は「その経路で作れるなら作る」。 既存の `revisor` リポの挙動は不変。
 */
export function resolveManualReleaseChannel({ repository, env = process.env, githubRelease }) {
  const workflow = resolveRepositoryWorkflow(repository, env);
  const releaseAvailable = workflow !== WORKFLOW_GITHUB;
  if (githubRelease === undefined || githubRelease === null) {
    return { workflow, githubRelease: releaseAvailable, githubReleaseAvailable: releaseAvailable };
  }
  if (githubRelease === true && !releaseAvailable) {
    throw new RevisorError(
      `${repository.repository} uses the GitHub workflow, which publishes tags without the GitHub App; `
        + "a GitHub Release cannot be created. Publish with githubRelease=false.",
    );
  }
  return { workflow, githubRelease: githubRelease === true, githubReleaseAvailable: releaseAvailable };
}
