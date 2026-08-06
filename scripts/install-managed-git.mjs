import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { assertSupportedGitRoot, managedGitPaths } from "../src/git-runtime.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function defaultTarget() {
  if (!process.env.LOCALAPPDATA) {
    throw new Error("LOCALAPPDATA is required when --target is omitted.");
  }
  return join(process.env.LOCALAPPDATA, "LUDIARS", "Revisor", "git");
}

function assertComplete(root, label) {
  const paths = managedGitPaths(root);
  const missing = [paths.git].filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(`${label} is not a complete Git for Windows runtime; missing: ${missing.join(", ")}`);
  }
}

const sourceOption = option("--source");
if (!sourceOption) {
  throw new Error("Usage: npm run install:git -- --source <complete Git for Windows root> [--target <path>]");
}

const source = resolve(sourceOption);
const target = resolve(option("--target") || defaultTarget());
const staging = join(dirname(target), `.git-install-${process.pid}`);

assertSupportedGitRoot(source);
assertComplete(source, "Source");
if (source === target) throw new Error("Source and target must be different directories.");
if (existsSync(target)) {
  assertComplete(target, "Existing Revisor managed Git");
  process.stdout.write(`Revisor managed Git already exists at ${target}\n`);
  process.exit(0);
}

mkdirSync(dirname(target), { recursive: true });
try {
  cpSync(source, staging, { recursive: true, errorOnExist: true });
  assertComplete(staging, "Staged runtime");
  renameSync(staging, target);
} catch (error) {
  if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  throw error;
}

process.stdout.write(`Installed Revisor managed Git at ${target}\n`);
