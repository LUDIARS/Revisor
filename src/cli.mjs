#!/usr/bin/env node
import { resolveManagedServicePort } from "./catalog.mjs";
import {
  hasGitHubAppCredentials,
  hasDiscordWebhookUrl,
  removeDiscordWebhookUrl,
  removeGitHubAppCredentials,
  resolveConfigPath,
  writeGitHubAppCredentials,
  writeDiscordWebhookUrl,
} from "./config.mjs";
import { pathToFileURL } from "node:url";
import { guardMainPush } from "./push-guard.mjs";
import { pushBranch } from "./branch-push.mjs";
import { option, runLocalPrCommand } from "./local-pr-commands.mjs";
import { runReviewWorker } from "./worker-command.mjs";
import { startRevisor } from "./server.mjs";
import { readLocalVersion, writeLocalVersion } from "./local-version.mjs";
import { startRuntimeDiagnostics } from "./runtime-diagnostics.mjs";
import { serviceLog } from "./service-log.mjs";

function printHelp(stdout) {
  stdout.write([
    "Usage:",
    "  revisor pr submit --repository <owner/name> --head-ref <branch> --title <text> [--body-file <path>] [--fast-lane]",
    "  revisor pr submit --json-file <path>   # same body the HTTP API accepts",
    "  revisor pr list [--repository <owner/name>] [--json]",
    "  revisor pr show|merge <number> [--json]",
    "  revisor pr close <number> --reason <text> [--json]   # 取り下げは理由が必須",
    "  revisor pr retry <number> [--fast-lane] [--force] [--json]",
    "                                        # --force: 止まったまま running の審査を打ち切って投げ直す",
    "  revisor pr fast-lane <number> [--session-id <id>] [--json]",
    "  revisor pr merge <number> --bypass --reason <text>   # CLI only: merge without a review",
    "  revisor pr merge <number> --defer-push               # merge locally and hold the GitHub publish",
    "  revisor publish-pending [--repository <owner/name>] [--json]  # send the held publishes",
    "  revisor pr bypassed [--all] [--json]                 # bypass merges awaiting follow-up review",
    "  revisor pr bypass-reviewed <number> [--note <text>]",
    "  revisor repo register --json-file <path>",
    "  revisor repo list [--json]",
    "  revisor repo set-workflow <owner/name> <revisor|github>  # publish via GitHub App, or plain push",
    "  revisor queue status [--json]",
    "  revisor sweep [--json]        # auto-merge the Test OK PRs that became mergeable",
    "  revisor run-worker            # run queued reviews until the queue drains, then exit",
    "",
    "  revisor serve                 # optional Web UI; reviews no longer depend on it",
    "  dw ui  # compatibility alias for revisor serve",
    "  revisor config path",
    "  revisor config github-app status",
    "  revisor config github-app set --app-id <id> --private-key-stdin",
    "  revisor config github-app remove",
    "  revisor config discord-webhook status",
    "  revisor config discord-webhook set --stdin",
    "  revisor config discord-webhook remove",
    "  revisor version show --repo <path>",
    "  revisor version set <MAJOR.MINOR.PATCH> --repo <path>",
    "  revisor push [--repo <path>] [--branch <name>] [--remote-branch <name>]",
    "               [--force-with-lease] [--actor <label>]  # 作業ブランチだけを GitHub へ送る",
    "  revisor guard-push --repo <path> --state <path>  # managed hook only",
    "",
  ].join("\n"));
}

function registerShutdown(close) {
  let isClosing = false;
  const shutdown = () => {
    if (isClosing) return;
    isClosing = true;
    Promise.resolve(close()).then(
      () => {
        process.exitCode = 0;
      },
      (error) => {
        process.stderr.write(`Error: ${error.message}\n`);
        process.exitCode = 1;
      },
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

async function readStdin(stream = process.stdin) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * `stdout` は差し替えられる。 テストが `process.stdout.write` を直接奪うと、
 * node:test 自身がレポータ用に書く V8 直列化フレームまで一緒に拾ってしまい、
 * 出力比較が実行順に依存して落ちる (test:enqueue のバイト列が混ざる実害があった)。
 */
export async function main(args, { stdin = process.stdin, stdout = process.stdout } = {}) {
  if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
    printHelp(stdout);
    return 0;
  }
  // 審査キューは記録なので、投入も参照もマージも常駐プロセス無しで完結する。
  const handled = await runLocalPrCommand(args, { stdin, stdout });
  if (handled !== null) return handled;
  if (args[0] === "run-worker" && args.length === 1) {
    const outcome = await runReviewWorker();
    stdout.write(
      outcome.skipped
        ? "Revisor worker: another worker is already draining the queue.\n"
        : `Revisor worker: ${outcome.ran} review(s) completed.\n`,
    );
    return 0;
  }
  if (args[0] === "config" && args[1] === "path" && args.length === 2) {
    stdout.write(`${resolveConfigPath(process.env)}\n`);
    return 0;
  }
  if (args[0] === "config" && args[1] === "github-app" && args[2] === "status") {
    stdout.write(hasGitHubAppCredentials(process.env) ? "configured\n" : "not configured\n");
    return 0;
  }
  if (args[0] === "config" && args[1] === "discord-webhook" && args[2] === "status") {
    stdout.write(hasDiscordWebhookUrl(process.env) ? "configured\n" : "not configured\n");
    return 0;
  }
  if (args[0] === "config" && args[1] === "discord-webhook" && args[2] === "set") {
    if (!args.includes("--stdin")) {
      throw new Error("discord-webhook set requires --stdin.");
    }
    writeDiscordWebhookUrl(await readStdin(stdin), process.env);
    stdout.write("Discord webhook URL saved.\n");
    return 0;
  }
  if (
    args[0] === "config"
    && args[1] === "discord-webhook"
    && args[2] === "remove"
    && args.length === 3
  ) {
    removeDiscordWebhookUrl(process.env);
    stdout.write("Discord webhook URL removed.\n");
    return 0;
  }
  if (args[0] === "config" && args[1] === "github-app" && args[2] === "set") {
    const appId = option(args, "--app-id");
    if (!appId || !args.includes("--private-key-stdin")) {
      throw new Error("github-app set requires --app-id and --private-key-stdin.");
    }
    writeGitHubAppCredentials({ appId, privateKey: await readStdin(stdin) }, process.env);
    stdout.write("GitHub App credentials saved.\n");
    return 0;
  }
  if (
    args[0] === "config"
    && args[1] === "github-app"
    && args[2] === "remove"
    && args.length === 3
  ) {
    removeGitHubAppCredentials(process.env);
    stdout.write("GitHub App credentials removed.\n");
    return 0;
  }
  if (args[0] === "version" && args[1] === "show") {
    const repoPath = option(args, "--repo") ?? process.cwd();
    stdout.write(`${await readLocalVersion(repoPath, { allowUninitialized: true })}\n`);
    return 0;
  }
  if (args[0] === "version" && args[1] === "set") {
    const repoPath = option(args, "--repo") ?? process.cwd();
    if (!args[2] || args[2].startsWith("--")) {
      throw new Error("version set requires MAJOR.MINOR.PATCH.");
    }
    const version = await writeLocalVersion(repoPath, args[2]);
    stdout.write(`${version}\n`);
    return 0;
  }
  if (args[0] === "push") {
    const result = await pushBranch({
      cwd: option(args, "--repo") ?? process.cwd(),
      branch: option(args, "--branch"),
      remoteBranch: option(args, "--remote-branch"),
      forceWithLease: args.includes("--force-with-lease"),
      actor: option(args, "--actor"),
    });
    stdout.write(
      `Pushed ${result.repository} ${result.branch} -> ${result.remoteBranch} `
      + `(${result.headSha.slice(0, 12)}).\n`,
    );
    return 0;
  }
  if (args[0] === "guard-push") {
    const repoPath = option(args, "--repo");
    const statePath = option(args, "--state");
    if (!repoPath || !statePath) {
      throw new Error("guard-push requires --repo and --state.");
    }
    const result = await guardMainPush({
      repoPath,
      statePath,
      input: await readStdin(stdin),
    });
    if (!result.allowed) {
      if (result.publicationRequired) {
        process.stderr.write(
          "Revisor blocked a direct main push. Merge and publish the reviewed local PR through Revisor.\n",
        );
        return 1;
      }
      if (Array.isArray(result.blockedRefs) && result.blockedRefs.length > 0) {
        process.stderr.write(
          `Revisor blocked non-main branch push: ${result.blockedRefs.join(", ")}. `
          + "Feature branches must remain local.\n",
        );
        return 1;
      }
      process.stderr.write(
        `Revisor blocked main push: ${result.findings.length} potential leakage finding(s). `
        + "Amend the local commit and push again; no branch data was sent to GitHub.\n",
      );
      for (const finding of result.findings) {
        process.stderr.write(`- ${finding.rule}: ${finding.path}:${finding.line}\n`);
      }
      return 1;
    }
    process.stderr.write(
      `Revisor push guard passed (${result.scannedAddedLines} added line(s) scanned).\n`,
    );
    return 0;
  }
  if ((args[0] !== "serve" && args[0] !== "ui") || args.length !== 1) {
    throw new Error(`Unknown command '${args.join(" ")}'.`);
  }
  const cwd = process.cwd();
  // 起動より先に据える。 起動そのものが失敗した回も 「いつ、 どう終わったか」 を残す。
  startRuntimeDiagnostics({ env: process.env, command: args[0] });
  let service;
  try {
    service = await startRevisor({
      cwd,
      env: process.env,
      port: resolveManagedServicePort(cwd, process.env),
    });
  } catch (error) {
    serviceLog("service_start_failed", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack ?? null : null,
    }, { level: "error" });
    throw error;
  }
  registerShutdown(service.close);
  stdout.write(`Revisor: ${service.url}\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
