import { composeReleaseNotes } from "./release-notes.mjs";
import { latestReleaseTag } from "./release-version.mjs";
import { redactSecretLines } from "./leakage.mjs";
import { contract } from './contract-runtime.mjs'; /* augur-inject:import:fde10c37 */
import augurContract_36d7e14d from '../contracts/collect-repository-changes.contract.mjs'; /* augur-inject:contract-predicate:eedd71d7 */

const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

function publicText(value) {
  return redactSecretLines(String(value ?? ""))
    .replace(/\s+/g, " ").trim()
    .replace(/@(everyone|here)/gi, `@${ZERO_WIDTH_SPACE}$1`)
    .replace(/<@/g, `<${ZERO_WIDTH_SPACE}@`);
}

function parseLog(output) {
  return String(output ?? "").split(/\r?\n/).filter(Boolean).map((line) => {
    const [sha = "", subject = ""] = line.split("\t", 2);
    return { sha, subject: publicText(subject) || "Untitled change" };
  });
}

function range(from, to) {
  return from ? `${from}..${to}` : to;
}

export async function collectRepositoryChanges({
  repository,
  from = null,
  to = null,
  store,
  runGit,
  listTags,
}) {
  const target = to ?? await runGit(repository.rootPath, ["rev-parse", repository.baseRef]);
  const previous = from ?? latestReleaseTag(await listTags(repository.rootPath, repository.baseRef));
  const commits = parseLog(await runGit(repository.rootPath, [
    "log", "--format=%H%x09%s", range(previous, target),
  ]));
  // 範囲内の merged local PR = merge commit が今回の commit 一覧に含まれるもの。
  // 日時や前タグとの比較ではリポ全史の merged PR が混ざるので、 commit sha で絞る。
  const commitShas = new Set(commits.map((commit) => commit.sha));
  const pullRequests = store.listPullRequests()
    .filter((pullRequest) => pullRequest.repository === repository.repository
      && pullRequest.status === "merged"
      && typeof pullRequest.mergeCommitSha === "string"
      && commitShas.has(pullRequest.mergeCommitSha))
    .map((pullRequest) => ({
      number: pullRequest.number,
      title: publicText(pullRequest.title),
      author: publicText(pullRequest.author),
      mergedAt: pullRequest.mergedAt ?? null,
    }));
  const markdown = previous
    ? composeReleaseNotes({
      repository: repository.repository,
      tag: String(target).slice(0, 12),
      previousTag: previous,
      kind: "minor",
      changes: commits,
    })
    : commits.map((commit) => `- ${commit.subject} (\`${commit.sha.slice(0, 12)}\`)`).join("\n");
  const notice = publicText([
    `[${repository.repository}] ${String(previous ?? "initial").slice(0, 12)} → ${String(target).slice(0, 12)}`,
    ...pullRequests.slice(0, 10).map((pullRequest) => `#${pullRequest.number} ${pullRequest.title}`),
  ].join("\n"));
  return { from: previous, to: target, commits, pullRequests, markdown, notice };
}
// @ts-expect-error augur-inject
collectRepositoryChanges = contract(collectRepositoryChanges, { ...augurContract_36d7e14d, contractId: 'C-1', mode: 'observe', sample: 1, where: 'src/repository-changes.mjs:25', rule: 'contract-wrap', id: '36d7e14d' }); /* augur-inject:contract-wrap:36d7e14d */
