import { readGitHubAppCredentials } from "./config.mjs";
import { GitHubAppClient } from "./github-app.mjs";
import {
  createLocalReleaseTag,
  listLocalReleaseTags,
  listRemoteReleaseTags,
  pushPublishedCommit,
} from "./git-publication.mjs";
import { composeReleaseNotes } from "./release-notes.mjs";
import {
  classifyReleaseKind,
  latestReleaseTag,
  selectReleaseTag,
} from "./release-version.mjs";
import { scanTextForLeaks } from "./leakage.mjs";
import { RevisorError } from "./errors.mjs";
import { prepareLocalVersionFile, writeLocalVersion } from "./local-version.mjs";
import { resolveVersionRootPath } from "./version-root.mjs";
import { git } from "./workspace.mjs";

async function releaseChanges(rootPath, previousTag, mergeCommitSha) {
  const output = await git(rootPath, [
    "log",
    "--format=%H%x09%s",
    `${previousTag}..${mergeCommitSha}`,
  ]);
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const separator = line.indexOf("\t");
    return {
      sha: separator === -1 ? line : line.slice(0, separator),
      subject: separator === -1 ? "Untitled change" : line.slice(separator + 1),
    };
  });
}

export async function publishMergedPullRequest({
  repository,
  pullRequest,
  expectedBaseSha,
  mergeCommitSha,
  preparedTag = null,
  env = process.env,
  createClient = (credentials) => new GitHubAppClient(credentials),
}) {
  // 版数の正本は登録 checkout。 理由と実害は `version-root.mjs` に書いた。
  const versionRootPath = resolveVersionRootPath(repository);
  const localVersion = await prepareLocalVersionFile(versionRootPath);
  const client = createClient(readGitHubAppCredentials(env));
  const token = await client.installationToken(repository.repository);
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
  const selection = preparedTag
    ? { tag: preparedTag, kind: "prepared" }
    : selectReleaseTag({
        releasedTags,
        localVersion,
      });
  let tag = selection.tag;
  const previousTag = latestReleaseTag(releasedTags.filter((candidate) => candidate !== tag));
  const releaseKind = selection.kind === "prepared"
    ? classifyReleaseKind(previousTag, tag)
    : selection.kind;
  // A patch tag prepared by an older Revisor is never promoted into a new
  // GitHub Release under the human-only major/minor policy.
  if (releaseKind === "patch") tag = null;
  const releaseNotes = tag
    ? composeReleaseNotes({
        repository: repository.repository,
        tag,
        previousTag,
        kind: releaseKind,
        changes: releaseKind === "initial"
          ? []
          : await releaseChanges(repository.rootPath, previousTag, mergeCommitSha),
      })
    : "";
  const leakage = scanTextForLeaks(releaseNotes, "release-notes");
  if (leakage.totalFindings > 0) {
    throw new RevisorError(
      `Release Notes contain ${leakage.totalFindings} potential information leakage finding(s).`,
    );
  }
  if (tag) {
    await createLocalReleaseTag({
      rootPath: repository.rootPath,
      mergeCommitSha,
      tag,
      message: `${tag}: human-selected ${releaseKind} release`,
    });
  }
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
    return { mergeCommitSha, releaseTag: null, releaseUrl: null };
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
  };
}
