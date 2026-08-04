import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RevisorError } from "./errors.mjs";
import { git } from "./workspace.mjs";

export const LOCAL_VERSION_FILE = ".revisor-version";
export const UNINITIALIZED_VERSION = "uninitialized";
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const OBJECT_NAME = /^[0-9a-fA-F]{7,64}$/;

function versionPath(rootPath) {
  return join(rootPath, LOCAL_VERSION_FILE);
}

export function normalizeLocalVersion(value, { allowUninitialized = false } = {}) {
  const version = String(value ?? "").trim();
  if (allowUninitialized && version === UNINITIALIZED_VERSION) return version;
  const match = VERSION.exec(version);
  if (!match || !match.slice(1).map(Number).every(Number.isSafeInteger)) {
    throw new RevisorError(
      `${LOCAL_VERSION_FILE} must contain one canonical MAJOR.MINOR.PATCH version.`,
    );
  }
  return version;
}

async function assertTracked(rootPath) {
  try {
    await git(rootPath, ["ls-files", "--error-unmatch", "--", LOCAL_VERSION_FILE]);
  } catch (error) {
    throw new RevisorError(
      // A local PR may never touch this path (assertLocalVersionUnchanged), so
      // the bootstrap commit has to be on the base branch before registration.
      `${LOCAL_VERSION_FILE} must be committed on the base branch before repository registration.`,
      { cause: error },
    );
  }
}

export async function prepareLocalVersionFile(rootPath) {
  await assertTracked(rootPath);
  const version = normalizeLocalVersion(
    await readFile(versionPath(rootPath), "utf8"),
    { allowUninitialized: true },
  );
  await git(rootPath, ["update-index", "--skip-worktree", "--", LOCAL_VERSION_FILE]);
  return version;
}

export async function readLocalVersion(rootPath, { allowUninitialized = false } = {}) {
  await assertTracked(rootPath);
  const flag = await git(rootPath, ["ls-files", "-t", "--", LOCAL_VERSION_FILE]);
  if (!flag.startsWith("S ")) {
    throw new RevisorError(
      `${LOCAL_VERSION_FILE} is not managed with skip-worktree; register the repository again.`,
    );
  }
  return normalizeLocalVersion(
    await readFile(versionPath(rootPath), "utf8"),
    { allowUninitialized },
  );
}

export async function assertLocalVersionUnchanged(rootPath, baseSha, headSha) {
  if (!OBJECT_NAME.test(baseSha) || !OBJECT_NAME.test(headSha)) {
    throw new RevisorError("Version-file comparison requires Git object names.");
  }
  const changed = await git(rootPath, [
    "diff",
    "--name-only",
    `${baseSha}...${headSha}`,
    "--",
    LOCAL_VERSION_FILE,
  ]);
  if (changed) {
    throw new RevisorError(
      `${LOCAL_VERSION_FILE} is Revisor-owned local state and cannot be changed by a local PR.`,
    );
  }
}

export async function writeLocalVersion(rootPath, tag) {
  const version = normalizeLocalVersion(String(tag).replace(/^v/, ""));
  await prepareLocalVersionFile(rootPath);
  await writeFile(versionPath(rootPath), `${version}\n`, "utf8");
  return version;
}
