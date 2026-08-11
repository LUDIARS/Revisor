import { RevisorError } from "./errors.mjs";
import { githubRemoteUrl } from "./authenticated-git.mjs";
import { runProcess } from "./process.mjs";
import { git } from "./workspace.mjs";

/**
 * GitHub Workflow (`workflow = "github"`) 側の送出。
 *
 * GitHub App token を組み立てず、 登録 checkout の `origin` が指す先へ、 その環境の
 * git 資格情報 (credential helper 等) でそのまま push する。 全 private で通常 push が
 * 通る org (MELPOT) は App を入れる理由が無く、 App 前提の経路だと保留にしか落ちない
 * (`spec/plan/workflow-selection-design.md` §1.2)。
 *
 * push を実行するのは Revisor 所有の隔離マージリポジトリ側。 マージコミットの
 * オブジェクトはそこにしか無く、 登録 checkout へ届くのは publish の後 (syncCheckout)
 * だからで、 送り先 URL だけを登録 checkout の `origin` から取る。
 */

function publishingEnvironment(env) {
  return {
    ...env,
    // 資格情報を対話で聞かれると publish がハングする。 聞かれた時点で失敗させ、
    // 保留 (deferred) へ落とす。
    GIT_TERMINAL_PROMPT: "0",
    // push guard は Revisor 自身の送出だけを通す (`push-guard.mjs`)。
    REVISOR_PUBLISHING: "1",
    ALLOW_MAIN_PUSH: "1",
  };
}

function remotePathMatchesRepository(pathname, repository) {
  const expected = `${repository}.git`.toLowerCase();
  return pathname.replace(/^\/+|\/+$/g, "").toLowerCase() === expected;
}

/**
 * The registered checkout is user-controlled state, so its `origin` must not
 * become an arbitrary Git transport.  In particular, accepting `ext::...`
 * would let a repository configuration select a process for Git to execute;
 * accepting another HTTPS host could send the user's credential-helper
 * credentials there.  GitHub SSH and HTTPS forms remain supported.
 */
export function assertGitHubPublishRemoteUrl(remoteUrl, repository) {
  const value = String(remoteUrl ?? "").trim();
  const scp = /^git@github\.com:([^\s?#]+)$/i.exec(value);
  if (scp && remotePathMatchesRepository(scp[1], repository)) return value;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new RevisorError(`Registered origin is not a GitHub URL for '${repository}'.`);
  }
  const isGitHub = parsed.hostname.toLowerCase() === "github.com";
  const isHttps = parsed.protocol === "https:" && !parsed.username && !parsed.password;
  const isSsh = parsed.protocol === "ssh:" && parsed.username === "git" && !parsed.password;
  if (
    !isGitHub
    || (!isHttps && !isSsh)
    || parsed.port
    || parsed.search
    || parsed.hash
    || !remotePathMatchesRepository(parsed.pathname, repository)
  ) {
    throw new RevisorError(`Registered origin is not a GitHub URL for '${repository}'.`);
  }
  return value;
}

export async function runPlainGit({ cwd, args, env = process.env }) {
  const result = await runProcess({
    command: "git",
    args,
    cwd,
    env: publishingEnvironment(env),
    timeoutMs: 120_000,
  });
  if (!result.ok) {
    throw new RevisorError(
      `git ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout.trim();
}

/**
 * 送り先は登録 checkout の `origin`。 登録が origin を持たない場合だけ、 リポジトリ名
 * から組み立てた GitHub の URL へ落とす。
 */
export async function resolvePublishRemoteUrl({
  repository,
  registeredRootPath,
  runGit = git,
}) {
  if (registeredRootPath) {
    let url;
    try {
      url = await runGit(registeredRootPath, ["remote", "get-url", "origin"]);
    } catch {
      // 登録 checkout に origin が無いだけ。 既定の GitHub URL で送る。
      return githubRemoteUrl(repository);
    }
    if (url) return assertGitHubPublishRemoteUrl(url, repository);
  }
  return githubRemoteUrl(repository);
}

/**
 * マージ結果 (と、 あればリリースタグ) を fast-forward push する。
 *
 * remote の状態照会 (`ls-remote`) は行わない。 非 fast-forward は push 自身が
 * 拒否するので、 事前照会を足しても防げるものが増えない。
 */
export async function pushWithLocalCredentials({
  repository,
  rootPath,
  registeredRootPath = null,
  baseRef,
  mergeCommitSha,
  tag = null,
  env = process.env,
  runGit = git,
  runPush = runPlainGit,
}) {
  const remoteUrl = await resolvePublishRemoteUrl({
    repository,
    registeredRootPath,
    runGit,
  });
  const refspecs = [`${mergeCommitSha}:refs/heads/${baseRef}`];
  if (tag) refspecs.push(`refs/tags/${tag}:refs/tags/${tag}`);
  await runPush({
    cwd: rootPath,
    args: [
      "push",
      ...(refspecs.length > 1 ? ["--atomic"] : []),
      remoteUrl,
      ...refspecs,
    ],
    env,
  });
  return { remoteUrl, refspecs };
}
