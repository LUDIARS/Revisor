import { readGitHubAppCredentials } from "./config.mjs";
import { GitHubAppClient } from "./github-app.mjs";
import { githubRemoteUrl, runAuthenticatedGit } from "./authenticated-git.mjs";
import { RevisorError } from "./errors.mjs";
import { git } from "./workspace.mjs";

const REMOTE_SHA = /^([0-9a-f]{40,64})\s+(\S+)$/i;

function sameSha(left, right) {
  return Boolean(left) && Boolean(right) && left.toLowerCase() === right.toLowerCase();
}

// GitHub 上で base ブランチが今どこを指しているかだけを読む。 publish 経路とは別に
// 「prepared は既に公開済みか」を判定するためだけの読み取りなので、 tag や Release は
// 見ない。
export async function readPublishedBaseSha({
  repository,
  baseRef,
  env = process.env,
  loadCredentials = readGitHubAppCredentials,
  createClient = (credentials) => new GitHubAppClient(credentials),
  runRemoteGit = runAuthenticatedGit,
}) {
  const client = createClient(loadCredentials(env));
  const token = await client.installationToken(repository.repository);
  const output = await runRemoteGit({
    cwd: repository.rootPath,
    args: [
      "ls-remote",
      githubRemoteUrl(repository.repository),
      `refs/heads/${baseRef}`,
    ],
    token,
    env,
  });
  const lines = output.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return null;
  const listed = lines
    .map((line) => REMOTE_SHA.exec(line.trim()))
    .find((match) => match?.[2] === `refs/heads/${baseRef}`);
  if (!listed) {
    throw new RevisorError(
      `GitHub returned an unreadable listing for '${baseRef}'.`,
    );
  }
  return listed[1];
}

async function parentOfPreparedMerge(rootPath, mergeCommitSha) {
  try {
    return await git(rootPath, ["rev-parse", `${mergeCommitSha}^`]);
  } catch {
    // A prepared merge without a parent cannot be compared against the base;
    // the caller falls back to asking GitHub whether it was already published.
    return null;
  }
}

async function isCommitPresent(rootPath, sha) {
  try {
    await git(rootPath, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

// 「含む / 含まない / ローカルでは判定できない」の 3 値を返す。 GitHub 側の commit が
// ローカルに無い場合を「含まない」に丸めると、 公開済みの prepared を捨てにいく。
async function containmentOfPreparedMerge(rootPath, containerSha, mergeCommitSha) {
  if (!containerSha) return "absent";
  if (sameSha(containerSha, mergeCommitSha)) return "contains";
  if (!await isCommitPresent(rootPath, containerSha)) return "unknown";
  try {
    await git(rootPath, ["merge-base", "--is-ancestor", mergeCommitSha, containerSha]);
    return "contains";
  } catch {
    return "excludes";
  }
}

function preparedBaseLabel(preparedBaseSha) {
  return preparedBaseSha ?? "an unknown base";
}

// prepared ref は「GitHub push の後・ローカル状態の更新前に落ちた」場合の冪等な再実行の
// ためのものだが、 「まだ公開されていない古い prepare」も同じ ref に残る。 後者を再利用
// すると expectedBaseSha が古い親に固定され、 publish の「GitHub が独立して動いた」検査に
// 恒久的に落ちる。 ここで両者を区別する。
export async function classifyPreparedMerge({
  repository,
  pullRequest,
  prepared,
  baseSha,
  env = process.env,
  readPublishedBase = readPublishedBaseSha,
}) {
  const rootPath = repository.rootPath;
  const preparedBaseSha = await parentOfPreparedMerge(rootPath, prepared.mergeCommitSha);
  if (sameSha(preparedBaseSha, baseSha)) {
    // 現在の base の上に載っている prepared は古くない。 GitHub が独立して動いていても
    // それは publish 側の安全弁が扱う話で、 作り直しても何も変わらない。
    return {
      action: "reuse",
      reason: "current_base",
      preparedBaseSha,
      publishedBaseSha: null,
      notice: null,
    };
  }
  let publishedBaseSha = null;
  try {
    publishedBaseSha = await readPublishedBase({
      repository,
      baseRef: pullRequest.baseRef,
      env,
    });
  } catch {
    // Authentication and transport failures can include credentials or private
    // endpoint details. The caller logs this notice, so do not interpolate the
    // original error here.
    return {
      action: "reuse",
      reason: "unverified",
      preparedBaseSha,
      publishedBaseSha: null,
      notice: `Local PR ${pullRequest.id}: kept the prepared merge ${prepared.mergeCommitSha} `
        + `built on ${preparedBaseLabel(preparedBaseSha)} even though local `
        + `'${pullRequest.baseRef}' has moved to ${baseSha}; GitHub could not be read `
        + "while verifying whether it was already published.",
    };
  }
  const containment = await containmentOfPreparedMerge(
    rootPath,
    publishedBaseSha,
    prepared.mergeCommitSha,
  );
  if (containment === "contains") {
    return {
      action: "reuse",
      reason: "published",
      preparedBaseSha,
      publishedBaseSha,
      notice: `Local PR ${pullRequest.id}: reused the prepared merge ${prepared.mergeCommitSha} `
        + `because GitHub '${pullRequest.baseRef}' (${publishedBaseSha}) already contains it, `
        + `while local '${pullRequest.baseRef}' is at ${baseSha}.`,
    };
  }
  if (containment === "unknown") {
    return {
      action: "reuse",
      reason: "unverified",
      preparedBaseSha,
      publishedBaseSha,
      notice: `Local PR ${pullRequest.id}: kept the prepared merge ${prepared.mergeCommitSha} `
        + `built on ${preparedBaseLabel(preparedBaseSha)}; GitHub '${pullRequest.baseRef}' is at `
        + `${publishedBaseSha}, which is not present locally, so publication could not be `
        + `verified. Fetch '${pullRequest.baseRef}' and retry.`,
    };
  }
  return {
    action: "rebuild",
    reason: "stale",
    preparedBaseSha,
    publishedBaseSha,
    notice: `Local PR ${pullRequest.id}: discarded the stale prepared merge `
      + `${prepared.mergeCommitSha} built on ${preparedBaseLabel(preparedBaseSha)}; local `
      + `'${pullRequest.baseRef}' has moved to ${baseSha} and GitHub `
      + `'${pullRequest.baseRef}' (${publishedBaseSha ?? "missing"}) does not contain it. `
      + `Rebuilding the squash merge on ${baseSha}.`,
  };
}
