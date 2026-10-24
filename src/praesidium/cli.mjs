#!/usr/bin/env node
import { resolve } from "node:path";
import { scanRepository } from "./scan.mjs";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--repo") {
  process.stderr.write("Usage: praesidium --repo <repository>\n");
  process.exitCode = 2;
} else {
  const result = await scanRepository({ root: resolve(args[1]) });
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exitCode = result.status === "passed" ? 0 : result.status === "failed" ? 1 : 2;
}
