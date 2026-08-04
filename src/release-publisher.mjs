import { readGitHubAppCredentials } from "./config.mjs";
import { GitHubAppClient } from "./github-app.mjs";
import {
  createLocalReleaseTag,
  listLocalReleaseTags,
  listRemoteReleaseTags,
  pushReleaseAtomically,
} from "./git-publication.mjs";
import { composeReleaseNotes } from "./release-notes.mjs";
import {
  classifyReleaseKind,
  latestReleaseTag,
  selectReleaseTag,
} from "./release-version.mjs";
import { scanTextForLeaks } from "./leakage.mjs";
import { RevisorError } from "./errors.mjs";
import {
  prepareLocalVersionFile,
  UNINITIALIZED_VERSION,
  writeLocalVersion,
} from "./local-version.mjs";

export async function publishMergedPullRequest({
  repository,
  pullRequest,
  expectedBaseSha,
  mergeCommitSha,
  preparedTag = null,
  env = process.env,
  createClient = (credentials) => new GitHubAppClient(credentials),
}) {
  const localVersion = await prepareLocalVersionFile(repository.rootPath);
  if (!preparedTag && localVersion === UNINITIALIZED_VERSION) {
    throw new RevisorError(
      "Initial version is not set; run 'revisor version set MAJOR.MINOR.PATCH --repo <path>' before publishing.",
    );
  }
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
  const tag = selection.tag;
  const previousTag = latestReleaseTag(releasedTags.filter((candidate) => candidate !== tag));
  const releaseKind = selection.kind === "prepared"
    ? classifyReleaseKind(previousTag, tag)
    : selection.kind;
  const releaseNotes = composeReleaseNotes(pullRequest, mergeCommitSha, {
    repository: repository.repository,
    tag,
    previousTag,
    kind: releaseKind,
  });
  const leakage = scanTextForLeaks(releaseNotes, "release-notes");
  if (leakage.totalFindings > 0) {
    throw new RevisorError(
      `Release Notes contain ${leakage.totalFindings} potential information leakage finding(s).`,
    );
  }
  await createLocalReleaseTag({
    rootPath: repository.rootPath,
    mergeCommitSha,
    tag,
    message: `${tag}: ${pullRequest.title}`,
  });
  await pushReleaseAtomically({
    repository: repository.repository,
    rootPath: repository.rootPath,
    baseRef: pullRequest.baseRef,
    expectedBaseSha,
    mergeCommitSha,
    tag,
    token,
    env,
  });
  let release = await client.releaseByTag(repository.repository, tag);
  if (!release) {
    release = await client.createRelease(repository.repository, {
      tag_name: tag,
      target_commitish: mergeCommitSha,
      name: `${tag} — ${pullRequest.title}`,
      body: releaseNotes,
      draft: false,
      prerelease: false,
    });
  }
  await writeLocalVersion(repository.rootPath, tag);
  return {
    mergeCommitSha,
    releaseTag: tag,
    releaseUrl: typeof release.html_url === "string" ? release.html_url : null,
  };
}
