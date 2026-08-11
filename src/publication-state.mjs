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
