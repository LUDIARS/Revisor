import { createHash } from "node:crypto";
import { git } from "./workspace.mjs";

/**
 * 保留した publish の記録。
 *
 * 記録先は Revisor 所有のマージリポジトリ内の private ref
 * (`refs/revisor/pending-publish/<sha256(localPrId)>`)。 マージコミットそのものを
 * 指すので、 後日の `revisor publish-pending` は Git だけで対象を再構成できる。
 * `refs/revisor/prepared/*` (中断復旧) とは名前空間が別で、 互いに干渉しない
 * (`spec/plan/deferred-publish-design.md` §1.4)。
 */

const PENDING_PUBLISH_NAMESPACE = "refs/revisor/pending-publish";

export function pendingPublishRef(localPrId) {
  const id = createHash("sha256").update(String(localPrId)).digest("hex");
  return `${PENDING_PUBLISH_NAMESPACE}/${id}`;
}

export async function rememberPendingPublish(rootPath, localPrId, mergeCommitSha) {
  await git(rootPath, ["update-ref", pendingPublishRef(localPrId), mergeCommitSha]);
}

export async function forgetPendingPublish(rootPath, localPrId, mergeCommitSha) {
  await deletePendingPublishRef(rootPath, pendingPublishRef(localPrId), mergeCommitSha);
}

// 記録の無い ref (PR が消された等) も後送の対象にはできるので、 ref 名そのもので
// 消せる口を用意しておく。
export async function deletePendingPublishRef(rootPath, ref, mergeCommitSha) {
  await git(rootPath, ["update-ref", "-d", ref, mergeCommitSha]);
}

/**
 * 保留中の publish を列挙する。
 *
 * @returns {Promise<Array<{ref: string, mergeCommitSha: string}>>}
 */
export async function listPendingPublishes(rootPath) {
  const output = await git(rootPath, [
    "for-each-ref",
    "--format=%(refname)%09%(objectname)",
    PENDING_PUBLISH_NAMESPACE,
  ]);
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [ref, mergeCommitSha] = line.split("\t");
    return { ref, mergeCommitSha };
  });
}
