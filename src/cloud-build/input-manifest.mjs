import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runProcess } from "../process.mjs";
import { sha256Hex } from "./canonical.mjs";
import { assertInputSize, normalizeInputPath } from "./input-policy.mjs";

async function gitOutput(repo, args) {
  const result = await runProcess({ command: "git", args, cwd: repo, timeoutMs: 60_000 });
  if (!result.ok) throw new Error(`git ${args[0]} failed: ${(result.stderr || "").trim().slice(0, 300)}`);
  return result.stdout.trim();
}

/**
 * Hashes each requested file and proves it is the head's content: the blob at
 * `<head>:<path>` must equal what `git hash-object` computes for the working
 * tree file, so uncommitted edits are never shipped as if they were the head.
 */
export async function buildInputManifest({ repo, headSha, paths }, {
  git = gitOutput,
  readFile = readFileSync,
  stat = statSync,
} = {}) {
  const manifest = [];
  for (const raw of paths) {
    const path = normalizeInputPath(raw);
    const absolute = join(repo, ...path.split("/"));
    const size = stat(absolute).size;
    assertInputSize(path, size);
    const headBlob = await git(repo, ["rev-parse", "--verify", `${headSha}:${path}`]);
    const worktreeBlob = await git(repo, ["hash-object", "--", path]);
    if (headBlob !== worktreeBlob) {
      throw new Error(`input '${path}' in the working tree differs from ${headSha.slice(0, 12)}; check out the head first.`);
    }
    manifest.push({ path, size, sha256: sha256Hex(readFile(absolute)), gitBlob: headBlob, absolute });
  }
  return manifest;
}
