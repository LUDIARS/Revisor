import { readGitHubAppCredentials } from "./config.mjs";
import { GitHubAppClient } from "./github-app.mjs";
import {
  listLocalReleaseTags,
  listRemoteReleaseTags,
  pushPublishedCommit,
} from "./git-publication.mjs";
import { publishWithoutGitHub } from "./deferred-publication.mjs";
import { resolveGitHubAccess } from "./github-reachability.mjs";
import { prepareRelease } from "./release-preparation.mjs";
import { PUBLICATION_PUBLISHED } from "./publication-state.mjs";
import { prepareLocalVersionFile, writeLocalVersion } from "./local-version.mjs";
import { resolveVersionRootPath } from "./version-root.mjs";

export async function publishMergedPullRequest({
  repository,
  pullRequest,
  expectedBaseSha,
  mergeCommitSha,
  preparedTag = null,
  // 明示保留 (`revisor pr merge <n> --defer-push`)。 GitHub へは一切触れない。
  deferPush = false,
  env = process.env,
  readCredentials = readGitHubAppCredentials,
  createClient = (credentials) => new GitHubAppClient(credentials),
}) {
  // 版数の正本は登録 checkout。 理由と実害は `version-root.mjs` に書いた。
  const versionRootPath = resolveVersionRootPath(repository);
  const localVersion = await prepareLocalVersionFile(versionRootPath);
  const access = await resolveGitHubAccess({
    repository,
    env,
    deferPush,
    readCredentials,
    createClient,
  });
  // App 未インストール / 明示保留だけがここへ来る。 それ以外の失敗は
  // `resolveGitHubAccess` がそのまま投げるので、 障害は隠れない。
  if (!access.reachable) {
    return publishWithoutGitHub({
      repository,
      pullRequest,
      mergeCommitSha,
      preparedTag,
      localVersion,
      reason: access.reason,
    });
  }
  const { client, token } = access;
  const remoteTags = await listRemoteReleaseTags({
    repository: repository.repository,
    rootPath: repository.rootPath,
    token,
    env,
  });
  const releasedTags = [
    ...await listLocalReleaseTags(repository.rootPath, pullRequest.baseRef),
    ...remoteTags,
  ];
  const { tag, releaseNotes } = await prepareRelease({
    repository,
    mergeCommitSha,
    preparedTag,
    localVersion,
    releasedTags,
  });
  await pushPublishedCommit({
    repository: repository.repository,
    rootPath: repository.rootPath,
    baseRef: pullRequest.baseRef,
    expectedBaseSha,
    mergeCommitSha,
    tag,
    token,
    env,
  });
  if (!tag) {
    return {
      mergeCommitSha,
      releaseTag: null,
      releaseUrl: null,
      publication: PUBLICATION_PUBLISHED,
    };
  }
  let release = await client.releaseByTag(repository.repository, tag);
  if (!release) {
    release = await client.createRelease(repository.repository, {
      tag_name: tag,
      target_commitish: mergeCommitSha,
      name: tag,
      body: releaseNotes,
      draft: false,
      prerelease: false,
    });
  }
  // 読み出しと同じ正本へ書き戻す。 隔離リポジトリへ書くと、 次回の publish が
  // 読む登録 checkout 側が古いままになり、 版数が巻き戻る。
  await writeLocalVersion(versionRootPath, tag);
  return {
    mergeCommitSha,
    releaseTag: tag,
    releaseUrl: typeof release.html_url === "string" ? release.html_url : null,
    publication: PUBLICATION_PUBLISHED,
  };
}
