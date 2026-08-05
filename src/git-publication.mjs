import { createHash } from "node:crypto";
import { RevisorError } from "./errors.mjs";
import { git } from "./workspace.mjs";
import { isReleaseTag } from "./release-version.mjs";
import { githubRemoteUrl, runAuthenticatedGit } from "./authenticated-git.mjs";

function refsByName(output) {
  return new Map(output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [sha, ref] = line.split(/\s+/, 2);
    return [ref, sha];
  }));
}

export async function listRemoteReleaseTags({
  repository,
  rootPath,
  token,
  env,
  runRemoteGit = runAuthenticatedGit,
}) {
  const output = await runRemoteGit({
    cwd: rootPath,
    args: ["ls-remote", "--tags", "--refs", githubRemoteUrl(repository), "refs/tags/v*"],
    token,
    env,
  });
  return output.split(/\r?\n/).filter(Boolean).map((line) =>
    line.split(/\s+/, 2)[1]?.replace(/^refs\/tags\//, "")).filter(isReleaseTag);
}

export async function listLocalReleaseTags(rootPath, baseRef) {
  const output = await git(rootPath, [
    "tag",
    "--merged",
    `refs/heads/${baseRef}`,
    "--list",
    "v*",
  ]);
  return output.split(/\r?\n/).filter(isReleaseTag);
}

function preparedRef(localPrId) {
  const id = createHash("sha256").update(String(localPrId)).digest("hex");
  return `refs/revisor/prepared/${id}`;
}

export async function rememberPreparedMerge(rootPath, localPrId, mergeCommitSha) {
  await git(rootPath, ["update-ref", preparedRef(localPrId), mergeCommitSha]);
}

export async function forgetPreparedMerge(rootPath, localPrId, mergeCommitSha) {
  try {
    await git(rootPath, ["update-ref", "-d", preparedRef(localPrId), mergeCommitSha]);
  } catch {
    // Publication has already succeeded and the base now reaches the commit.
    // A stale private ref is harmless and can be replaced by a later retry.
  }
}

export async function findPreparedMerge(rootPath, localPrId) {
  let mergeCommitSha;
  try {
    mergeCommitSha = await git(rootPath, ["rev-parse", "--verify", preparedRef(localPrId)]);
  } catch {
    // Compatibility with tagged preparations made before private recovery refs.
    mergeCommitSha = await git(rootPath, [
      "log",
      "--all",
      "--fixed-strings",
      `--grep=Revisor-Local-PR: ${localPrId}`,
      "--format=%H",
      "-1",
    ]);
  }
  if (!mergeCommitSha) return null;
  const tags = (await git(rootPath, ["tag", "--points-at", mergeCommitSha, "--list", "v*"]))
    .split(/\r?\n/)
    .filter(isReleaseTag);
  if (tags.length > 1) {
    throw new RevisorError(`Prepared merge '${localPrId}' has multiple release tags.`);
  }
  return { mergeCommitSha, tag: tags[0] ?? null };
}

export async function createLocalReleaseTag({
  rootPath,
  mergeCommitSha,
  tag,
  message,
}) {
  const existing = await git(rootPath, ["tag", "--list", tag]);
  if (existing) {
    const target = await git(rootPath, ["rev-list", "-n", "1", tag]);
    if (target.toLowerCase() === mergeCommitSha.toLowerCase()) return;
    throw new RevisorError(`Release tag '${tag}' already points to another commit.`);
  }
  await git(rootPath, [
    "-c",
    "user.name=LUDIARS Revisor",
    "-c",
    "user.email=revisor@localhost",
    "tag",
    "-a",
    tag,
    mergeCommitSha,
    "-m",
    message,
  ]);
}

async function remoteState({
  repository,
  rootPath,
  baseRef,
  tag,
  token,
  env,
  runRemoteGit,
}) {
  const output = await runRemoteGit({
    cwd: rootPath,
    args: [
      "ls-remote",
      githubRemoteUrl(repository),
      `refs/heads/${baseRef}`,
      ...(tag ? [`refs/tags/${tag}`, `refs/tags/${tag}^{}`] : []),
    ],
    token,
    env,
  });
  const refs = refsByName(output);
  return {
    baseSha: refs.get(`refs/heads/${baseRef}`) ?? null,
    tagSha: tag
      ? refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`) ?? null
      : null,
  };
}

export async function pushPublishedCommit({
  repository,
  rootPath,
  baseRef,
  expectedBaseSha,
  mergeCommitSha,
  tag,
  token,
  env = process.env,
  runGit = git,
  runRemoteGit = runAuthenticatedGit,
}) {
  const remote = await remoteState({
    repository,
    rootPath,
    baseRef,
    tag,
    token,
    env,
    runRemoteGit,
  });
  if (!remote.baseSha) {
    throw new RevisorError(`GitHub branch '${baseRef}' does not exist.`);
  }
  if (remote.baseSha.toLowerCase() !== mergeCommitSha.toLowerCase()) {
    let mergeBase;
    try {
      mergeBase = await runGit(rootPath, ["merge-base", remote.baseSha, expectedBaseSha]);
    } catch {
      throw new RevisorError(
        `GitHub '${baseRef}' is not contained in the local source of truth.`,
      );
    }
    if (mergeBase.toLowerCase() !== remote.baseSha.toLowerCase()) {
      throw new RevisorError(
        `GitHub '${baseRef}' moved independently; reconcile it with local '${baseRef}' before publishing.`,
      );
    }
  }
  if (tag && remote.tagSha && remote.tagSha.toLowerCase() !== mergeCommitSha.toLowerCase()) {
    throw new RevisorError(`GitHub release tag '${tag}' points to another commit.`);
  }
  const refspecs = [];
  if (remote.baseSha.toLowerCase() !== mergeCommitSha.toLowerCase()) {
    refspecs.push(`${mergeCommitSha}:refs/heads/${baseRef}`);
  }
  if (tag && !remote.tagSha) refspecs.push(`refs/tags/${tag}:refs/tags/${tag}`);
  if (refspecs.length === 0) return;
  await runRemoteGit({
    cwd: rootPath,
    args: [
      "push",
      ...(refspecs.length > 1 ? ["--atomic"] : []),
      githubRemoteUrl(repository),
      ...refspecs,
    ],
    token,
    env,
  });
}

export async function pushReleaseAtomically(request) {
  if (!request.tag) throw new TypeError("Atomic Release publication requires a tag.");
  return pushPublishedCommit(request);
}
