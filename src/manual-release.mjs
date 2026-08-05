import { readGitHubAppCredentials } from "./config.mjs";
import { RevisorError } from "./errors.mjs";
import {
  createLocalReleaseTag,
  listLocalReleaseTags,
  listRemoteReleaseTags,
  pushReleaseAtomically,
} from "./git-publication.mjs";
import { GitHubAppClient } from "./github-app.mjs";
import { scanTextForLeaks } from "./leakage.mjs";
import { readLocalVersion, writeLocalVersion } from "./local-version.mjs";
import { composeManualReleaseNotes } from "./release-notes.mjs";
import { latestReleaseTag, nextManualReleaseTag } from "./release-version.mjs";
import { git } from "./workspace.mjs";

export async function publishManualRelease({
  repository,
  kind,
  expectedVersion,
  title,
  notes,
  env = process.env,
  createClient = (credentials) => new GitHubAppClient(credentials),
  readCredentials = readGitHubAppCredentials,
  getLocalTags = listLocalReleaseTags,
  getRemoteTags = listRemoteReleaseTags,
  createTag = createLocalReleaseTag,
  push = pushReleaseAtomically,
  readVersion = readLocalVersion,
  writeVersion = writeLocalVersion,
  runGit = git,
  scan = scanTextForLeaks,
}) {
  const branch = await runGit(repository.rootPath, ["symbolic-ref", "--short", "HEAD"]);
  if (branch !== repository.baseRef) {
    throw new RevisorError(
      `Immediate release requires '${repository.baseRef}' to be checked out (found '${branch}').`,
    );
  }
  const currentVersion = await readVersion(repository.rootPath);
  if (currentVersion !== expectedVersion) {
    throw new RevisorError(
      `Version changed from '${expectedVersion}' to '${currentVersion}'; refresh before publishing.`,
    );
  }
  const currentTag = `v${currentVersion}`;
  const tag = nextManualReleaseTag(currentVersion, kind);
  const baseSha = await runGit(repository.rootPath, [
    "rev-parse",
    "--verify",
    `refs/heads/${repository.baseRef}`,
  ]);
  const client = createClient(readCredentials(env));
  const token = await client.installationToken(repository.repository);
  const releasedTags = [
    ...await getLocalTags(repository.rootPath, repository.baseRef),
    ...await getRemoteTags({
      repository: repository.repository,
      rootPath: repository.rootPath,
      token,
      env,
    }),
  ];
  const latestTag = latestReleaseTag(releasedTags);
  if (latestTag && latestTag !== currentTag && latestTag !== tag) {
    throw new RevisorError(
      `Local version '${currentTag}' does not match the latest release '${latestTag}'.`,
    );
  }
  const previousTag = latestReleaseTag(releasedTags.filter((candidate) => candidate !== tag));
  const releaseNotes = composeManualReleaseNotes({
    title,
    body: notes,
    repository: repository.repository,
    currentVersion,
    tag,
    previousTag,
    kind,
    commitSha: baseSha,
  });
  const leakage = scan(releaseNotes, "release-notes");
  if (leakage.totalFindings > 0) {
    throw new RevisorError(
      `Release Notes contain ${leakage.totalFindings} potential information leakage finding(s).`,
    );
  }
  await createTag({
    rootPath: repository.rootPath,
    mergeCommitSha: baseSha,
    tag,
    message: `${tag}: ${title}`,
  });
  await push({
    repository: repository.repository,
    rootPath: repository.rootPath,
    baseRef: repository.baseRef,
    expectedBaseSha: baseSha,
    mergeCommitSha: baseSha,
    tag,
    token,
    env,
  });
  let release = await client.releaseByTag(repository.repository, tag);
  if (!release) {
    release = await client.createRelease(repository.repository, {
      tag_name: tag,
      target_commitish: baseSha,
      name: `${tag} — ${title}`,
      body: releaseNotes,
      draft: false,
      prerelease: false,
    });
  }
  await writeVersion(repository.rootPath, tag);
  return {
    repository: repository.repository,
    previousVersion: currentVersion,
    version: tag.slice(1),
    tag,
    commitSha: baseSha,
    // The UI turns this into an href. Only an absolute GitHub-scheme URL may
    // reach the DOM, so a malformed API response cannot become a script URL.
    releaseUrl: typeof release.html_url === "string" && release.html_url.startsWith("https://")
      ? release.html_url
      : null,
  };
}
