import { dirname, resolve } from "node:path";
import { RevisorError } from "./errors.mjs";
import { BRANCH_PUSH_ENV_FLAG } from "./branch-push-flag.mjs";
import { githubRemoteUrl, runAuthenticatedGit } from "./authenticated-git.mjs";
import { resolveGitHubAccess } from "./github-reachability.mjs";
import { resolveRepositoryWorkflow, WORKFLOW_GITHUB } from "./repository-workflow.mjs";
import { assertGitHubPublishRemoteUrl } from "./plain-git-publication.mjs";
import { LocalPrStore, redirectLegacyStorePath, resolveStatePath } from "./state-store.mjs";
import { serviceLog } from "./service-log.mjs";
import { git } from "./workspace.mjs";
import { runProcess } from "./process.mjs";

/**
 * 作業ブランチを GitHub へ送り出す経路。
 *
 * これまで GitHub へ届く push は「審査済み local PR のマージ結果を base へ送る」
 * publication 一本だけで、 作業ブランチには経路そのものが無かった (push guard が
 * base 以外の refs/heads を無条件で落とす)。 一方で バックアップ・他ホストとの
 * 共有・GitHub 上でのレビューのように、 マージを伴わずブランチだけ送りたい要求は
 * 実在する。 ここはその要求だけを引き受け、 base とタグには一切触れない。
 *
 * base への push を拒むのは publication と役割が競合するため。 版数・Release・
 * remote 分岐の保護は publication 側の不変条件で、 それを迂回する第二の経路を
 * 作らない。
 *
 * @implements spec/plan/branch-push-design.md
 */

export { BRANCH_PUSH_ENV_FLAG };

/** ブランチ名として受け付ける形 (refspec・option への混入を防ぐ)。 */
const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*(?:^|\/)\.)(?!.*(?:^|\/)[^/]*\.lock(?:\/|$))[A-Za-z0-9._\/-]+$/;

function assertBranchName(value, label) {
  const branch = String(value ?? "").trim();
  if (!BRANCH_NAME.test(branch) || branch.endsWith("/") || branch.endsWith(".lock")) {
    throw new RevisorError(`${label} '${value}' is not a valid branch name.`);
  }
  return branch;
}

/**
 * worktree から呼ばれても登録リポジトリへ辿り着けるようにする。
 *
 * セッションの実装は task 専用 worktree で行うのが常で、 その path は Revisor に
 * 登録されていない。 `--git-common-dir` の親が本体 checkout なので、 そこで引き直す。
 */
export async function resolveRegisteredRepository({ cwd, store, run = git }) {
  const candidates = [resolve(cwd)];
  let commonDirectory;
  try {
    commonDirectory = await run(cwd, ["rev-parse", "--git-common-dir"]);
  } catch (error) {
    throw new RevisorError(`'${cwd}' is not inside a git repository.`, { cause: error });
  }
  candidates.push(dirname(resolve(cwd, commonDirectory)));
  for (const candidate of candidates) {
    const repository = store.findRepositoryByPath(candidate);
    if (repository) return repository;
  }
  throw new RevisorError(
    `Repository is not registered in Revisor: ${candidates[candidates.length - 1]}`,
  );
}

/** 送出しようとしている ref が publication の領分を侵していないか。 */
function assertNotBaseRef(repository, remoteBranch) {
  if (remoteBranch !== repository.baseRef) return;
  throw new RevisorError(
    `'${remoteBranch}' is the reviewed base of ${repository.repository}. `
    + "Merge the local PR through Revisor instead of pushing the base directly.",
  );
}

async function currentBranch(cwd, run) {
  const branch = await run(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === "HEAD") {
    throw new RevisorError("HEAD is detached; pass --branch to name the branch to push.");
  }
  return branch;
}

/**
 * GitHub App の installation token で送る (LUDIARS の既定)。
 *
 * 認可の旗は `pushBranch` が組み立てた `env` に既に載っている。 送出手段ごとに
 * 旗を立て直すと、 認可の判断が transport 側へ散る。
 */
async function pushWithAppToken({
  repository,
  refspec,
  options,
  env,
  access,
  authorizedPublication,
}) {
  await runAuthenticatedGit({
    cwd: repository.rootPath,
    args: ["push", ...options, githubRemoteUrl(repository.repository), refspec],
    token: access.token,
    env,
    // App authentication is shared with base publication, but this route must
    // not inherit its authorization for base refs or tags.
    authorizedPublication,
  });
}

/**
 * その環境の git 資格情報で送る (`workflow = "github"` の org)。
 *
 * 送り先は登録 checkout の `origin` から取り、 publication と同じ検証を通す。
 */
async function pushWithLocalCredentials({ repository, refspec, options, env, run = runProcess }) {
  const remoteUrl = assertGitHubPublishRemoteUrl(
    await git(repository.rootPath, ["remote", "get-url", "origin"]),
    repository.repository,
  );
  const result = await run({
    command: "git",
    args: ["push", ...options, remoteUrl, refspec],
    cwd: repository.rootPath,
    env: { ...env, GIT_TERMINAL_PROMPT: "0" },
    timeoutMs: 120_000,
  });
  if (!result.ok) {
    throw new RevisorError(
      `Branch push failed: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
}

/**
 * 作業ブランチ 1 本を GitHub へ送る。
 *
 * @param {object} request
 * @param {string} request.cwd 呼び出し元の作業ディレクトリ (worktree 可)。
 * @param {string|null} [request.branch] 送るローカルブランチ (既定は HEAD)。
 * @param {string|null} [request.remoteBranch] 送り先ブランチ (既定は同名)。
 * @param {boolean} [request.forceWithLease] 既存 ref を上書きする (lease 付き)。
 * @param {string|null} [request.actor] 指示した人物 / セッションの識別子。
 */
export async function pushBranch({
  cwd,
  branch = null,
  remoteBranch = null,
  forceWithLease = false,
  actor = null,
  statePath = null,
  env = process.env,
  store = null,
  run = git,
  log = serviceLog,
  resolveAccess = resolveGitHubAccess,
  pushAuthenticated = pushWithAppToken,
  pushPlain = pushWithLocalCredentials,
}) {
  const openStore = store
    ?? new LocalPrStore({ path: redirectLegacyStorePath(statePath ?? resolveStatePath(env)) });
  const repository = await resolveRegisteredRepository({ cwd, store: openStore, run });
  const localBranch = branch
    ? assertBranchName(branch, "Branch")
    : await currentBranch(cwd, run);
  const targetBranch = remoteBranch
    ? assertBranchName(remoteBranch, "Remote branch")
    : localBranch;
  assertNotBaseRef(repository, targetBranch);

  // 送る中身を先に確定させる。 送出後に ref が動いても記録は「何を送ったか」を指す。
  const headSha = await run(repository.rootPath, ["rev-parse", `refs/heads/${localBranch}`]);
  const workflow = resolveRepositoryWorkflow(repository, env);
  const refspec = `refs/heads/${localBranch}:refs/heads/${targetBranch}`;
  const options = forceWithLease ? ["--force-with-lease"] : [];
  const detail = {
    repository: repository.repository,
    branch: localBranch,
    remoteBranch: targetBranch,
    headSha,
    workflow,
    forceWithLease,
    actor,
  };
  log("branch_push_started", detail);

  // 認可はここで 1 回だけ決める。 push guard はこの旗を見て base 以外の ref を通す。
  const {
    REVISOR_PUBLISHING: _publicationAuthorization,
    ALLOW_MAIN_PUSH: _legacyPublicationAuthorization,
    ...branchEnvironment
  } = env;
  const pushEnv = { ...branchEnvironment, [BRANCH_PUSH_ENV_FLAG]: "1" };
  if (workflow === WORKFLOW_GITHUB) {
    await pushPlain({ repository, refspec, options, env: pushEnv });
    log("branch_push_completed", detail);
    return { ...detail, pushed: true };
  }
  const access = await resolveAccess({ repository, env });
  if (!access.reachable) {
    log("branch_push_refused", { ...detail, reason: access.reason }, { level: "warn" });
    throw new RevisorError(`Branch push could not reach GitHub: ${access.reason}`);
  }
  await pushAuthenticated({
    repository,
    refspec,
    options,
    env: pushEnv,
    access,
    authorizedPublication: false,
  });
  log("branch_push_completed", detail);
  return { ...detail, pushed: true };
}
