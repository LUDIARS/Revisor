#!/usr/bin/env node
import { resolve } from "node:path";
import { changedSourcePaths } from "./files.mjs";
import { scanRepository } from "./scan.mjs";

const args = process.argv.slice(2);
const scoped = args.length === 4 && args[2] === "--base";
if ((args.length !== 2 && !scoped) || args[0] !== "--repo") {
  process.stderr.write("Usage: praesidium --repo <repository> [--base <ref>]\n");
  process.exitCode = 2;
} else {
  const root = resolve(args[1]);
  let changedPaths;
  // An uncomputable change set keeps the whole-repository native scope.
  if (scoped) { try { changedPaths = changedSourcePaths(root, args[3]); } catch { changedPaths = undefined; } }
  const result = await scanRepository({ root, changedPaths });
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exitCode = result.status === "passed" ? 0 : result.status === "failed" ? 1 : 2;
}
