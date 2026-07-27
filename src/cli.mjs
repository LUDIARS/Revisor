#!/usr/bin/env node
import { resolveServicePort } from "./catalog.mjs";
import { resolveConfigPath } from "./config.mjs";
import { startRevisor } from "./server.mjs";

function printHelp() {
  process.stdout.write([
    "Usage:",
    "  revisor serve",
    "  revisor config path",
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

async function main(args) {
  if (args.length === 0 || args[0] === "help" || args[0] === "--help") {
    printHelp();
    return 0;
  }
  if (args[0] === "config" && args[1] === "path" && args.length === 2) {
    process.stdout.write(`${resolveConfigPath(process.env)}\n`);
    return 0;
  }
  if (args[0] !== "serve" || args.length !== 1) {
    throw new Error(`Unknown command '${args.join(" ")}'.`);
  }
  const cwd = process.cwd();
  const service = await startRevisor({
    cwd,
    env: process.env,
    port: resolveServicePort(cwd),
  });
  registerShutdown(service.close);
  process.stdout.write(`Revisor: ${service.url}\n`);
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
