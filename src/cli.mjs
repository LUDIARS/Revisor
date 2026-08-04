#!/usr/bin/env node
import { resolveManagedServicePort } from "./catalog.mjs";
import {
  hasGitHubAppCredentials,
  removeGitHubAppCredentials,
  resolveConfigPath,
  writeGitHubAppCredentials,
} from "./config.mjs";
import { pathToFileURL } from "node:url";
import { guardMainPush } from "./push-guard.mjs";
import { startRevisor } from "./server.mjs";
import { readLocalVersion, writeLocalVersion } from "./local-version.mjs";

function printHelp() {
  process.stdout.write([
    "Usage:",
    "  revisor serve",
    "  dw ui  # compatibility alias for revisor serve",
    "  revisor config path",
    "  revisor config github-app status",
    "  revisor config github-app set --app-id <id> --private-key-stdin",
    "  revisor config github-app remove",
    "  revisor version show --repo <path>",
    "  revisor version set <MAJOR.MINOR.PATCH> --repo <path>",
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

function option(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
}

async function readStdin(stream = process.stdin) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

export async function main(args, { stdin = process.stdin } = {}) {
  if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
    printHelp();
    return 0;
  }
  if (args[0] === "config" && args[1] === "path" && args.length === 2) {
    process.stdout.write(`${resolveConfigPath(process.env)}\n`);
    return 0;
  }
  if (args[0] === "config" && args[1] === "github-app" && args[2] === "status") {
    process.stdout.write(hasGitHubAppCredentials(process.env) ? "configured\n" : "not configured\n");
    return 0;
  }
  if (args[0] === "config" && args[1] === "github-app" && args[2] === "set") {
    const appId = option(args, "--app-id");
    if (!appId || !args.includes("--private-key-stdin")) {
      throw new Error("github-app set requires --app-id and --private-key-stdin.");
    }
    writeGitHubAppCredentials({ appId, privateKey: await readStdin(stdin) }, process.env);
    process.stdout.write("GitHub App credentials saved.\n");
    return 0;
  }
  if (
    args[0] === "config"
    && args[1] === "github-app"
    && args[2] === "remove"
    && args.length === 3
  ) {
    removeGitHubAppCredentials(process.env);
    process.stdout.write("GitHub App credentials removed.\n");
    return 0;
  }
  if (args[0] === "version" && args[1] === "show") {
    const repoPath = option(args, "--repo") ?? process.cwd();
    process.stdout.write(`${await readLocalVersion(repoPath, { allowUninitialized: true })}\n`);
    return 0;
  }
  if (args[0] === "version" && args[1] === "set") {
    const repoPath = option(args, "--repo") ?? process.cwd();
    if (!args[2] || args[2].startsWith("--")) {
      throw new Error("version set requires MAJOR.MINOR.PATCH.");
    }
    const version = await writeLocalVersion(repoPath, args[2]);
    process.stdout.write(`${version}\n`);
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
  const service = await startRevisor({
    cwd,
    env: process.env,
    port: resolveManagedServicePort(cwd, process.env),
  });
  registerShutdown(service.close);
  process.stdout.write(`Revisor: ${service.url}\n`);
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
