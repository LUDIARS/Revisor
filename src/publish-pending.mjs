import { isReleaseTag } from "./release-version.mjs";
import {
  deletePendingPublishRef,
  listPendingPublishes,
  pendingPublishRef,
} from "./pending-publish.mjs";
import { publishMergedPullRequest } from "./release-publisher.mjs";
import { resolveMergeRepositoryPath } from "./merge-repository.mjs";
import { PUBLICATION_DEFERRED, PUBLICATION_PUBLISHED } from "./publication-state.mjs";
import { git } from "./workspace.mjs";

/**
 * 保留した publish の一括後送 (`revisor publish-pending`)。
 *
 * 保留経路はローカルを通常マージと同じ終局状態にしてあるので、 ここで足りない
 * のは GitHub への push と Release 作成だけ。 通常の publish をそのまま再実行し、
 * 成功したものから pending ref を消して記録を `published` へ引き上げる。
 * まだ到達できないものは skip して残す — 到達不能はこのコマンドの失敗ではない
 * (`spec/plan/deferred-publish-design.md` §1.3)。
 */

async function readMergeParent(rootPath, mergeCommitSha) {
  return git(rootPath, ["rev-parse", `${mergeCommitSha}^`]);
}

async function readPreparedTag(rootPath, mergeCommitSha) {
  const tags = (await git(rootPath, ["tag", "--points-at", mergeCommitSha, "--list", "v*"]))
    .split(/\r?\n/)
    .filter(isReleaseTag);
  return tags[0] ?? null;
}

async function pathIsRepository(rootPath) {
  try {
    return await git(rootPath, ["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch {
    return false;
  }
}

// Pending refs are named from a PR-ID digest, so `for-each-ref` order is
// unrelated to merge order. Publishing a descendant first makes the remote
// base check fail even though its parent is pending in the same batch.
async function pendingPublishesInMergeOrder(rootPath, pending) {
  if (pending.length < 2) return pending;
  const byCommit = new Map();
  for (const candidate of pending) {
    const key = candidate.mergeCommitSha.toLowerCase();
    const matches = byCommit.get(key) ?? [];
    matches.push(candidate);
    byCommit.set(key, matches);
  }
  const commits = await git(rootPath, [
    "rev-list",
    "--topo-order",
    "--reverse",
    ...pending.map((candidate) => candidate.mergeCommitSha),
  ]);
  return commits.split(/\r?\n/).flatMap((commit) =>
    byCommit.get(commit.toLowerCase()) ?? []);
}

// pending ref の名前は local PR id のダイジェストなので逆算できない。 記録側の
// PR を同じ導出で引き直して突き合わせる。
function pullRequestsByPendingRef(pullRequests, repositoryName) {
  return new Map(pullRequests
    .filter((pullRequest) =>
      pullRequest.repository.toLowerCase() === repositoryName.toLowerCase())
    .map((pullRequest) => [pendingPublishRef(pullRequest.id), pullRequest]));
}

async function publishOnePending({
  repository,
  mergeRootPath,
  pending,
  pullRequest,
  env,
  publish,
}) {
  const publishRepository = {
    ...repository,
    registeredRootPath: repository.rootPath,
    rootPath: mergeRootPath,
  };
  const publication = await publish({
    repository: publishRepository,
    pullRequest,
    expectedBaseSha: await readMergeParent(mergeRootPath, pending.mergeCommitSha),
    mergeCommitSha: pending.mergeCommitSha,
    preparedTag: await readPreparedTag(mergeRootPath, pending.mergeCommitSha),
    env,
  });
  return publication;
}

async function publishRepositoryPending({
  repository,
  pullRequests,
  mergeRootPath,
  env,
  publish,
  store,
  entries,
}) {
  if (!await pathIsRepository(mergeRootPath)) return;
  const pending = await listPendingPublishes(mergeRootPath);
  if (pending.length === 0) return;
  const byRef = pullRequestsByPendingRef(pullRequests, repository.repository);
  for (const candidate of await pendingPublishesInMergeOrder(mergeRootPath, pending)) {
    const pullRequest = byRef.get(candidate.ref) ?? null;
    const entry = {
      repository: repository.repository,
      number: pullRequest?.number ?? null,
      mergeCommitSha: candidate.mergeCommitSha,
      status: "published",
      reason: null,
    };
    try {
      const publication = await publishOnePending({
        repository,
        mergeRootPath,
        pending: candidate,
        // 記録が見つからない ref も送出そのものは可能。 base だけは登録値を使う。
        pullRequest: pullRequest ?? { id: null, baseRef: repository.baseRef },
        env,
        publish,
      });
      if (publication?.publication === PUBLICATION_DEFERRED) {
        entry.status = "skipped";
        entry.reason = publication.deferredReason ?? "GitHub is still unreachable.";
        entries.push(entry);
        continue;
      }
      try {
        await deletePendingPublishRef(mergeRootPath, candidate.ref, candidate.mergeCommitSha);
      } catch (error) {
        // 送出そのものは成功している。 残った ref は次回の再実行で消える
        // (push も Release 作成も冪等) ので、 失敗として報告はしない。
        entry.reason = `published, but the pending ref remains: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
      if (pullRequest) {
        store.updatePullRequest(pullRequest.id, {
          publication: PUBLICATION_PUBLISHED,
          deferredPublishReason: null,
          releaseTag: publication?.releaseTag ?? pullRequest.releaseTag ?? null,
          releaseUrl: publication?.releaseUrl ?? null,
          publishedAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      entry.status = "failed";
      entry.reason = error instanceof Error ? error.message : String(error);
    }
    entries.push(entry);
  }
}

export async function publishPendingPublications({
  store,
  statePath = store?.path,
  repository: repositoryFilter = null,
  env = process.env,
  publish = publishMergedPullRequest,
  resolveMergeRoot = (repository) => resolveMergeRepositoryPath({ repository, statePath }),
  publicationCoordinator = null,
} = {}) {
  if (!store) throw new TypeError("Publishing pending merges requires a state store.");
  const repositories = store.listRepositories().filter((candidate) =>
    !repositoryFilter
    || candidate.repository.toLowerCase() === String(repositoryFilter).toLowerCase());
  const pullRequests = store.listPullRequests();
  const entries = [];
  const run = async () => {
    for (const repository of repositories) {
      await publishRepositoryPending({
        repository,
        pullRequests,
        mergeRootPath: resolveMergeRoot(repository),
        env,
        publish,
        store,
        entries,
      });
    }
  };
  // base ref を進める経路と同じ直列化に乗せる。 保留分の push だけが並走して
  // GitHub の base を動かすと、 同時に走るマージが乖離判定で落ちる。
  if (publicationCoordinator) await publicationCoordinator.run(run);
  else await run();
  return {
    pending: entries.length,
    published: entries.filter((entry) => entry.status === "published").length,
    skipped: entries.filter((entry) => entry.status === "skipped").length,
    failed: entries.filter((entry) => entry.status === "failed").length,
    entries,
  };
}
