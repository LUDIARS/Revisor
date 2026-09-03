/**
 * ローカルマージが GitHub まで届いたかどうかの 2 状態。
 *
 * `published` は従来どおり push と Release まで完了した状態。 `deferred` は
 * ローカル側だけ終局し、 GitHub への送出を保留した状態で、 `revisor publish-pending`
 * が後から `published` へ引き上げる (`spec/plan/deferred-publish-design.md`)。
 */
export const PUBLICATION_PUBLISHED = "published";
export const PUBLICATION_DEFERRED = "deferred";

export function isDeferredPublication(publication) {
  return typeof publication === "object"
    && publication !== null
    && publication.publication === PUBLICATION_DEFERRED;
}

/**
 * 保留のまま残っているマージを一覧向けに射影する。
 *
 * 保留は「後で送る」を人間が覚えていないと永久に送られない。 `revisor publish-pending` を
 * 叩くか state を直接読むかしないと気づけない状態だったので、 盤面から辿れる形にする
 * (bypass マージに `revisor pr bypassed` があるのと同じ理由)。
 *
 * 出所は state の `publication` 列にする。 `refs/revisor/pending-publish/*` を数える方法も
 * あるが、 表示のために merge repository の git を触りに行くと、 repository が未作成の
 * 環境で一覧そのものが出せなくなる。
 */
export function deferredPublications(pullRequests = []) {
  return pullRequests
    .filter(isDeferredPublication)
    .map((pr) => ({
      repository: pr.repository,
      number: pr.number ?? null,
      title: pr.title ?? "",
      mergeCommitSha: pr.mergeCommitSha ?? null,
      reason: pr.deferredPublishReason ?? null,
      mergedAt: pr.mergedAt ?? null,
    }))
    // 古い保留ほど忘れられているので先に出す。 mergedAt が無い記録は末尾へ。
    .sort((a, b) => {
      if (a.mergedAt === null) return b.mergedAt === null ? 0 : 1;
      if (b.mergedAt === null) return -1;
      return a.mergedAt.localeCompare(b.mergedAt);
    });
}
