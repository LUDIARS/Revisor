import { access, readFile, unlink, writeFile } from "node:fs/promises";
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

async function isTracked(rootPath) {
  const tracked = await git(rootPath, ["ls-files", "--", LOCAL_VERSION_FILE]);
  return tracked === LOCAL_VERSION_FILE;
}

async function assertTracked(rootPath) {
  if (await isTracked(rootPath)) return;
  throw new RevisorError(
    `${LOCAL_VERSION_FILE} must be committed on the base branch before publishing.`,
  );
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
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

// This projection feeds the Releases, dashboard, and settings tables, so every
// failure has to become that one project's state. A registration whose root
// path moved away or stopped being a repository would otherwise reject the
// whole /api/releases response and blank the repository table on three pages.
export async function inspectLocalVersionState(rootPath) {
  try {
    if (!await isTracked(rootPath)) {
      return {
        status: "missing",
        version: null,
        managed: false,
      };
    }
    const version = normalizeLocalVersion(
      await readFile(versionPath(rootPath), "utf8"),
      { allowUninitialized: true },
    );
    const flag = await git(rootPath, ["ls-files", "-t", "--", LOCAL_VERSION_FILE]);
    return {
      status: version === UNINITIALIZED_VERSION ? "uninitialized" : "ready",
      version,
      managed: flag.startsWith("S "),
    };
  } catch (error) {
    return {
      status: "invalid",
      version: null,
      managed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// Repository registration must remain possible for installations created
// before the version contract. A missing file is projected to the Releases UI;
// tracked files are made local-only immediately.
export async function prepareRegisteredVersionFile(rootPath) {
  const state = await inspectLocalVersionState(rootPath);
  if (state.status === "missing") return state;
  if (state.status === "invalid") throw new RevisorError(state.error);
  const version = await prepareLocalVersionFile(rootPath);
  return {
    status: version === UNINITIALIZED_VERSION ? "uninitialized" : "ready",
    version,
    managed: true,
  };
}

export async function initializeLocalVersion(rootPath, baseRef, initialVersion) {
  const version = normalizeLocalVersion(initialVersion);
  const state = await inspectLocalVersionState(rootPath);
  if (state.status === "ready") {
    throw new RevisorError(`Version is already registered as '${state.version}'.`);
  }
  if (state.status === "invalid") throw new RevisorError(state.error);
  if (state.status === "uninitialized") {
    return writeLocalVersion(rootPath, version);
  }

  const branch = await git(rootPath, ["symbolic-ref", "--short", "HEAD"]);
  if (branch !== baseRef) {
    throw new RevisorError(
      `Version bootstrap requires '${baseRef}' to be checked out (found '${branch}').`,
    );
  }
  const path = versionPath(rootPath);
  if (await pathExists(path)) {
    throw new RevisorError(
      `${LOCAL_VERSION_FILE} exists but is not tracked; preserve or remove it before registration.`,
    );
  }
  let committed = false;
  try {
    await writeFile(path, `${UNINITIALIZED_VERSION}\n`, "utf8");
    await git(rootPath, ["add", "--", LOCAL_VERSION_FILE]);
    await git(rootPath, [
      "-c",
      "user.name=LUDIARS Revisor",
      "-c",
      "user.email=revisor@localhost",
      "commit",
      "--no-verify",
      "--only",
      "-m",
      "chore: bootstrap Revisor version state",
      "--",
      LOCAL_VERSION_FILE,
    ]);
    committed = true;
  } finally {
    if (!committed) {
      try {
        await git(rootPath, ["reset", "HEAD", "--", LOCAL_VERSION_FILE]);
      } catch {
        // The index may not contain the new path; cleanup remains best-effort.
      }
      await unlink(path).catch(() => undefined);
    }
  }
  return writeLocalVersion(rootPath, version);
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
