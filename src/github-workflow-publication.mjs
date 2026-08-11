import { listLocalReleaseTags } from "./git-publication.mjs";
import { pushWithLocalCredentials } from "./plain-git-publication.mjs";
import { prepareRelease } from "./release-preparation.mjs";
import { PUBLICATION_DEFERRED, PUBLICATION_PUBLISHED } from "./publication-state.mjs";
import { writeLocalVersion } from "./local-version.mjs";
import { resolveVersionRootPath } from "./version-root.mjs";

/**
 * GitHub Workflow の publish (`spec/plan/workflow-selection-design.md` §1.2)。
 *
 * Revisor Workflow との差は 3 点だけ。
 *   - GitHub App を使わない (client も token も組み立てない)。
 *   - remote tags を照会せず、 リリースタグの既出判定はローカルタグだけで行う。
 *   - GitHub Release を作らない。 タグは通常の git タグとして push する。
 *
 * `.revisor-version` のゲート・審査ゲート・セキュリティスキャン・タグ選定は共通の
 * `prepareRelease` をそのまま通すので不変。
 *
 * push 失敗 (資格情報・ネットワーク) は投げずに保留 (deferred) を返す。 ローカルの
 * マージまで巻き戻す理由が無く、 `revisor publish-pending` が同じ経路で後送できる。
 */
export async function publishWithGitHubWorkflow({
  repository,
  pullRequest,
  mergeCommitSha,
  preparedTag = null,
  localVersion,
  env = process.env,
  push = pushWithLocalCredentials,
}) {
  const releasedTags = await listLocalReleaseTags(repository.rootPath, pullRequest.baseRef);
  const { tag } = await prepareRelease({
    repository,
    mergeCommitSha,
    preparedTag,
    localVersion,
    releasedTags,
  });
  try {
    await push({
      repository: repository.repository,
      rootPath: repository.rootPath,
      registeredRootPath: repository.registeredRootPath ?? null,
      baseRef: pullRequest.baseRef,
      mergeCommitSha,
      tag,
      env,
    });
  } catch (error) {
    return {
      mergeCommitSha,
      releaseTag: tag,
      releaseUrl: null,
      publication: PUBLICATION_DEFERRED,
      deferredReason: `Plain push to GitHub failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  // 版数の正本は登録 checkout。 保留のときに書かないのは Revisor Workflow と同じで、
  // 書いてしまうと後送が同じ版を publish できなくなる。
  if (tag) await writeLocalVersion(resolveVersionRootPath(repository), tag);
  return {
    mergeCommitSha,
    releaseTag: tag,
    releaseUrl: null,
    publication: PUBLICATION_PUBLISHED,
  };
}
