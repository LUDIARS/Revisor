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
import { syncPackageVersion } from "./package-version.mjs";
import { notifyRepositoryEvent } from "./repository-notification.mjs";

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
  notify = notifyRepositoryEvent,
  syncPackage = syncPackageVersion,
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
  const headSha = () => runGit(repository.rootPath, [
    "rev-parse",
    "--verify",
    `refs/heads/${repository.baseRef}`,
  ]);
  const preSyncSha = await headSha();
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
  // `package.json` の追従は tag を打つ前に済ませる。 後ろに置くと push されない commit が
  // base に残り、 merge パイプラインの分岐検出を誤爆させる。 ここで commit すれば公開が
  // base と tag を atomic に push するので、 ツリーも origin も一致したままになる。
  // 版の食い違い検査を通してから積む — 弾かれる公開で base を動かさないため。
  const packageSync = await syncPackage({
    rootPath: repository.rootPath,
    version: tag.slice(1),
    runGit,
  });
  const baseSha = await headSha();
  // 追従 commit を積んだあとで公開が失敗したら、 その commit だけを巻き戻す。 残すと
  // 「公開していないのに版が上がった commit」 が base に居座る。 自分が積んだ 1 本で
  // あることを HEAD で確かめてからでないと戻さない。 push が通ったあとは origin にも
  // 載っているので、 二度と戻さない。
  const rollbackPackageSync = async () => {
    if (!packageSync.synced) return;
    if (await headSha().catch(() => null) !== baseSha) return;
    await runGit(repository.rootPath, ["reset", "--hard", preSyncSha]).catch(() => undefined);
  };
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
  try {
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
  } catch (error) {
    await rollbackPackageSync();
    throw error;
  }
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
  const result = {
    repository: repository.repository,
    previousVersion: currentVersion,
    version: tag.slice(1),
    tag,
    commitSha: baseSha,
    packageVersionSync: packageSync,
    // The UI turns this into an href. Only an absolute GitHub-scheme URL may
    // reach the DOM, so a malformed API response cannot become a script URL.
    releaseUrl: typeof release.html_url === "string" && release.html_url.startsWith("https://")
      ? release.html_url
      : null,
  };
  // GitHub Release creation is the transaction boundary. Webhook observability
  // follows it and never rolls the Release back when a destination is offline.
  try {
    const text = [`[${repository.repository}] Release ${tag}`, title, releaseNotes.slice(0, 800), result.releaseUrl]
      .filter(Boolean).join("\n");
    await notify({
      repository,
      event: "release",
      text,
      kind,
      tag,
      previousTag,
      version: result.version,
      title,
      notice: text,
      releaseUrl: result.releaseUrl,
      publishedAt: new Date().toISOString(),
      env,
    });
  } catch {
    // Notification is observability after the Release transaction, never a
    // reason to report a successfully created Release as failed.
  }
  return result;
}
