import { createLocalReleaseTag } from "./git-publication.mjs";
import { composeReleaseNotes } from "./release-notes.mjs";
import {
  classifyReleaseKind,
  latestReleaseTag,
  selectReleaseTag,
} from "./release-version.mjs";
import { scanTextForLeaks } from "./leakage.mjs";
import { RevisorError } from "./errors.mjs";
import { git } from "./workspace.mjs";

/**
 * publish のうち GitHub へ触れない部分 — リリースタグの選定・Release Notes の
 * 組み立て・漏洩スキャン・ローカルタグ作成。
 *
 * 通常の publish と保留 (deferred) publish はここまで完全に同一で、 違いは
 * その後に push / Release 作成を行うかどうかだけ。 分けておかないと、 保留経路が
 * タグ選定やゲートを別実装で持つことになり、 いずれ食い違う。
 */

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

export async function prepareRelease({
  repository,
  mergeCommitSha,
  preparedTag = null,
  localVersion,
  releasedTags,
}) {
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
  return { tag, releaseNotes };
}
