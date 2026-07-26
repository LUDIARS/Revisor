import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runProcess } from "./process.mjs";

function normalizePath(path) {
  return resolve(path).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

async function runAnatomia(cliPath, cwd, args, timeoutMs = 10 * 60_000) {
  const result = await runProcess({
    command: process.execPath,
    args: [cliPath, ...args],
    cwd,
    timeoutMs,
  });
  if (!result.ok) {
    throw new Error(`Anatomia ${args.slice(0, 2).join(" ")} failed: ${
      result.stderr.trim() || result.stdout.trim()
    }`);
  }
  return result.stdout;
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

export async function resolveAnatomiaCli(anatomiaFolder) {
  if (typeof anatomiaFolder !== "string" || !anatomiaFolder.trim()) {
    throw new Error("Anatomia folder is not configured");
  }
  const cliPath = join(resolve(anatomiaFolder), "bin", "anatomia.mjs");
  await access(cliPath);
  return cliPath;
}

export async function ensureInitialAnalysis({ cliPath, repoPath, repository }) {
  const listed = parseJson(
    await runAnatomia(cliPath, repoPath, ["project", "list", "--json"]),
    "Anatomia project list",
  );
  const normalizedRepo = normalizePath(repoPath);
  let project = listed.projects?.find((candidate) =>
    normalizePath(candidate.rootPath) === normalizedRepo);
  if (!project) {
    project = parseJson(
      await runAnatomia(cliPath, repoPath, [
        "project",
        "add",
        repository.split("/").at(-1),
        repoPath,
        "--json",
      ]),
      "Anatomia project add",
    );
  }
  const analysis = parseJson(
    await runAnatomia(cliPath, repoPath, ["project", "analyze", project.id, "--json"]),
    "Anatomia project analyze",
  );
  return { project, analysis };
}

export async function analyzePr({ cliPath, cwd, base }) {
  const result = await runProcess({
    command: process.execPath,
    args: [cliPath, "pr-review", "--repo", cwd, "--base", base, "--json"],
    cwd,
    timeoutMs: 10 * 60_000,
    env: { ...process.env, ANATOMIA_CACHE: "off" },
  });
  if (!result.ok) {
    throw new Error(`Anatomia PR analysis failed: ${
      result.stderr.trim() || result.stdout.trim()
    }`);
  }
  return parseJson(result.stdout, "Anatomia PR analysis");
}
