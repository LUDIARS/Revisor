import { readFileSync } from "node:fs";
import {
  validateFastLanePromotion,
  validatePullRequestSubmission,
  validateRepositoryRegistration,
} from "./local-contracts.mjs";
import { publishPendingPublications } from "./publish-pending.mjs";
import {
  assertRepositoryWorkflow,
  resolveRepositoryWorkflow,
} from "./repository-workflow.mjs";
import { createReviewContext } from "./review-context.mjs";

const LOCAL_COMMANDS = new Set([
  "pr:submit",
  "pr:list",
  "pr:show",
  "pr:retry",
  "pr:fast-lane",
  "pr:close",
  "pr:merge",
  "pr:bypassed",
  "pr:bypass-reviewed",
  "repo:register",
  "repo:list",
  "repo:set-workflow",
  "queue:status",
  "sweep",
  "publish-pending",
]);

/**
 * local PR 操作の CLI 面。 バックエンドを立てずに、HTTP と同じ検証・同じサービスを通す。
 *
 * 入力は HTTP と同じ JSON 本文を第一級にしている。 検証器を共有しないと「API では通るが
 * CLI では通らない」差が必ず生まれるうえ、日本語の title / body をシェル引数に直書きすると
 * 環境によって壊れるため、本文はファイル / stdin から渡せる形を正とする。
 */

export function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  // 欠けた値の直後に別 option が来た場合、それを値として監査記録へ入れない。
  return value === undefined || value.startsWith("--") ? null : value;
}

async function readStdin(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

// JSON 本文の入手経路。 `--json-file` が既定で、`--json-stdin` はパイプ用。
async function readJsonBody(args, stdin) {
  const path = option(args, "--json-file");
  if (path) return JSON.parse(readFileSync(path, "utf8"));
  if (args.includes("--json-stdin")) return JSON.parse(await readStdin(stdin));
  return null;
}

function submissionBody(args, jsonBody) {
  if (jsonBody) return jsonBody;
  const bodyFile = option(args, "--body-file");
  return {
    repository: option(args, "--repository"),
    title: option(args, "--title"),
    body: bodyFile ? readFileSync(bodyFile, "utf8") : "",
    author: option(args, "--author") ?? "local",
    head_ref: option(args, "--head-ref"),
    ...(option(args, "--base-ref") ? { base_ref: option(args, "--base-ref") } : {}),
    ...(option(args, "--session-id") ? { session_id: option(args, "--session-id") } : {}),
    ...(args.includes("--fast-lane") ? { fast_lane: true } : {}),
  };
}

function findByNumber(store, value) {
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`'${value}' is not a local PR number.`);
  const pullRequest = store.listPullRequests().find((candidate) => candidate.number === number);
  if (!pullRequest) throw new Error(`Local PR #${number} was not found.`);
  return pullRequest;
}

function summarize(pullRequest) {
  return [
    `#${pullRequest.number}`,
    pullRequest.repository,
    `${pullRequest.status}/${pullRequest.checkStatus}`,
    pullRequest.title,
  ].join("  ");
}

export async function runLocalPrCommand(args, {
  cwd = process.cwd(),
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  createContext = createReviewContext,
} = {}) {
  const [scope, action, ...rest] = args;
  const json = args.includes("--json");
  const write = (value) => stdout.write(
    json ? `${JSON.stringify(value, null, 2)}\n` : `${value}\n`,
  );
  // 引数を取らないコマンド (`sweep` / `publish-pending`) は、直後に来るのが option
  // なので、 それを副コマンド名として引くと自分自身を見失う。
  const namedAction = action === undefined || action.startsWith("--") ? undefined : action;
  const command = namedAction === undefined ? scope : `${scope}:${namedAction}`;
  if (!LOCAL_COMMANDS.has(command)) return null;
  const context = createContext({ cwd, env });
  const { store, localPrService, jobs, publicationCoordinator } = context;

  if (scope === "pr" && action === "submit") {
    const submission = validatePullRequestSubmission(
      submissionBody(args, await readJsonBody(args, stdin)),
    );
    const pullRequest = await localPrService.submitPullRequest(submission);
    write(json ? pullRequest : `Submitted ${summarize(pullRequest)}`);
    return 0;
  }
  if (scope === "pr" && action === "list") {
    const repository = option(args, "--repository");
    const pullRequests = localPrService.listPullRequests()
      .filter((candidate) => !repository || candidate.repository === repository);
    write(json ? pullRequests : pullRequests.map(summarize).join("\n") || "(no local PRs)");
    return 0;
  }
  if (scope === "pr" && action === "show") {
    const pullRequest = findByNumber(store, rest[0]);
    write(json ? pullRequest : summarize(pullRequest));
    return 0;
  }
  if (scope === "pr" && action === "retry") {
    const pullRequest = findByNumber(store, rest[0]);
    const queued = await localPrService.retryPullRequest(pullRequest.id, {
      fastLane: args.includes("--fast-lane"),
      // 止まった審査の回復は人間の判断。 自動では殺さないので CLI からしか通らない。
      force: args.includes("--force"),
    });
    write(json ? queued : `Re-queued ${summarize(queued)}`);
    return 0;
  }
  if (scope === "pr" && action === "fast-lane") {
    const pullRequest = findByNumber(store, rest[0]);
    const promotion = validateFastLanePromotion({
      session_id: option(args, "--session-id"),
    });
    const promoted = await localPrService.promotePullRequest(pullRequest.id, promotion);
    write(json ? promoted : `Moved ${summarize(promoted)} to the fast lane`);
    return 0;
  }
  if (scope === "pr" && action === "close") {
    const pullRequest = findByNumber(store, rest[0]);
    // サービス側でも弾くが、 CLI では「何を渡せば通るか」を先に言う方が早い。
    if (!String(option(args, "--reason") ?? "").trim()) {
      throw new Error("pr close requires --reason (it is what makes the withdrawal reviewable).");
    }
    const closed = await localPrService.closePullRequest(pullRequest.id, {
      reason: option(args, "--reason"),
    });
    write(json ? closed : `Closed ${summarize(closed)}`);
    return 0;
  }
  if (scope === "pr" && action === "merge") {
    const pullRequest = findByNumber(store, rest[0]);
    // バイパスは CLI 限定。 HTTP 経路は `bypass` を渡さないので、ここでしか成立しない。
    const bypass = args.includes("--bypass")
      ? { reason: option(args, "--reason"), actor: "cli" }
      : null;
    if (bypass && !String(bypass.reason ?? "").trim()) {
      throw new Error("--bypass requires --reason (it is what makes the follow-up review possible).");
    }
    // 明示保留。 GitHub へは送らずローカルだけ終局させ、 送出は
    // `revisor publish-pending` へ回す。
    const deferPush = args.includes("--defer-push");
    const merged = await localPrService.mergePullRequest(pullRequest.id, {
      ...(bypass ? { bypass } : {}),
      ...(deferPush ? { deferPush: true } : {}),
    });
    write(json
      ? merged
      : `${bypass ? "Bypass-merged" : "Merged"} ${summarize(merged)} (${merged.mergeCommitSha})`
        + (merged.publication === "deferred"
          ? " — GitHub publish は保留しました ('revisor publish-pending' で後送)"
          : ""));
    return 0;
  }
  // バイパスで入った変更の後追いレビュー対象一覧。 印を付けただけで追えなければ、
  // 「後で見る」は必ず流れる。
  if (scope === "pr" && action === "bypassed") {
    const pending = store.listPullRequests()
      .filter((candidate) => candidate.bypassMerge
        && (args.includes("--all") || !candidate.bypassMerge.reviewedAfterRecovery));
    write(json
      ? pending
      : pending.map((candidate) =>
        `${summarize(candidate)}  bypass=${candidate.bypassMerge.at} 理由=${candidate.bypassMerge.reason}`,
      ).join("\n") || "(no bypass merges awaiting review)");
    return 0;
  }
  if (scope === "pr" && action === "bypass-reviewed") {
    const pullRequest = findByNumber(store, rest[0]);
    if (!pullRequest.bypassMerge) throw new Error(`Local PR #${pullRequest.number} was not bypass-merged.`);
    const updated = store.updatePullRequest(pullRequest.id, {
      bypassMerge: {
        ...pullRequest.bypassMerge,
        reviewedAfterRecovery: true,
        reviewedAt: new Date().toISOString(),
        reviewNote: option(args, "--note") ?? null,
      },
    });
    write(json ? updated : `Marked ${summarize(updated)} as reviewed after the bypass merge`);
    return 0;
  }
  if (scope === "repo" && action === "register") {
    const body = await readJsonBody(args, stdin);
    if (!body) throw new Error("repo register requires --json-file or --json-stdin.");
    const registration = validateRepositoryRegistration(body);
    const repository = await localPrService.registerRepository(registration);
    write(json ? repository : `Registered ${repository.repository} (${repository.rootPath})`);
    return 0;
  }
  if (scope === "repo" && action === "list") {
    const repositories = store.listRepositories();
    write(json
      ? repositories
      : repositories.map((entry) =>
        `${entry.repository}  ${resolveRepositoryWorkflow(entry, env)}  ${entry.rootPath}`)
        .join("\n"));
    return 0;
  }
  // 属性 1 つの変更。 登録本文を作り直させないために専用コマンドにしてある。
  if (scope === "repo" && action === "set-workflow") {
    const name = rest[0];
    if (!name) throw new Error("repo set-workflow requires <owner/name> <revisor|github>.");
    const workflow = assertRepositoryWorkflow(rest[1], "workflow");
    const updated = store.updateRepositoryWorkflow(name, workflow);
    if (!updated) throw new Error(`Repository '${name}' is not registered.`);
    write(json ? updated : `${updated.repository} now publishes with the ${workflow} workflow`);
    return 0;
  }
  if (scope === "queue" && action === "status") {
    const state = jobs.state();
    write(json
      ? state
      : `queued=${state.queued} running=${state.running} standard=${state.lanes?.standard ?? 0}`
        + ` fast=${state.lanes?.fast ?? 0} jobs=${state.jobs.length}`);
    return 0;
  }
  // 保留した publish の一括後送。 GitHub App が届くようになったものから送り、
  // まだ届かないものは残す。
  if (scope === "publish-pending" && namedAction === undefined) {
    const summary = await publishPendingPublications({
      store,
      statePath: store.path,
      repository: option(args, "--repository"),
      env,
      publicationCoordinator,
    });
    write(json
      ? summary
      : [
        `pending=${summary.pending} published=${summary.published}`
        + ` skipped=${summary.skipped} failed=${summary.failed}`,
        ...summary.entries.map((entry) =>
          `${entry.status}  ${entry.repository}  `
          + `${entry.number === null ? "(no record)" : `#${entry.number}`}  `
          + `${entry.mergeCommitSha}${entry.reason ? `  ${entry.reason}` : ""}`),
      ].join("\n"));
    return 0;
  }
  if (scope === "sweep" && namedAction === undefined) {
    const summary = await localPrService.sweepAutoMerge();
    write(json
      ? summary
      : `attempted=${summary.attempted} merged=${summary.merged} failed=${summary.failed}`);
    return 0;
  }
  return null;
}
