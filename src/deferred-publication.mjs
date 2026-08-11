import { listLocalReleaseTags } from "./git-publication.mjs";
import { prepareRelease } from "./release-preparation.mjs";
import { PUBLICATION_DEFERRED } from "./publication-state.mjs";

/**
 * GitHub へ届かない状況で、 ローカル側だけを通常マージと同じ終局状態にする。
 *
 * 行うのはリリースタグの選定とローカルタグ作成まで。 push・GitHub Release 作成・
 * remote tags 照会は行わず、 `.revisor-version` の書き戻しも行わない — 版数の正本を
 * 「公開済み」へ進めてしまうと、 後日の `revisor publish-pending` が同じ版を publish
 * できなくなる (`spec/plan/deferred-publish-design.md` §1.2)。
 */
export async function publishWithoutGitHub({
  repository,
  pullRequest,
  mergeCommitSha,
  preparedTag = null,
  localVersion,
  reason,
}) {
  const releasedTags = await listLocalReleaseTags(repository.rootPath, pullRequest.baseRef);
  const { tag } = await prepareRelease({
    repository,
    mergeCommitSha,
    preparedTag,
    localVersion,
    releasedTags,
  });
  return {
    mergeCommitSha,
    releaseTag: tag,
    releaseUrl: null,
    publication: PUBLICATION_DEFERRED,
    deferredReason: reason,
  };
}
