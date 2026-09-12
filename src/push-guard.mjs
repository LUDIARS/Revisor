import {
  access,
  chmod,
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { BRANCH_PUSH_ENV_FLAG } from "./branch-push-flag.mjs";
import { scanAddedDiffForLeaks } from "./leakage.mjs";
import { LocalPrStore, redirectLegacyStorePath } from "./state-store.mjs";
import { git } from "./workspace.mjs";
import { runProcess } from "./process.mjs";

const MANAGED_MARKER = "# LUDIARS Revisor managed pre-push hook";
const ZERO_SHA = /^0+$/;

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function gitEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    key !== "GIT_CONFIG_COUNT" && !/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)));
}

async function unconfiguredGit(repoPath, args) {
  const result = await runProcess({ command: "git", args, cwd: repoPath, env: gitEnvironment() });
  if (!result.ok) throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout.trim();
}

function unsafeOriginalHookDirectory(directory) {
  const normalized = resolve(directory).toLowerCase();
  return normalized.startsWith(resolve(tmpdir()).toLowerCase()) || normalized.includes("concordia-session-hooks");
}

async function existingFile(path) {
  try { return (await stat(path)).isFile(); } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

export async function pushGuardNeedsInstall(options) {
  const commonDirectory = resolve(options.repoPath, await git(options.repoPath, ["rev-parse", "--git-common-dir"]));
  const hookPath = resolve(commonDirectory, "revisor-hooks", "pre-push");
  try {
    const content = await readFile(hookPath, "utf8");
    return !content.includes(MANAGED_MARKER)
      || !content.includes(shellQuote(options.cliPath))
      || !content.includes(shellQuote(options.statePath))
      || !content.includes(shellQuote(options.repoPath))
      || !content.includes(shellQuote(options.nodePath ?? process.execPath));
  } catch (error) { if (error?.code === "ENOENT") return true; throw error; }
}

export async function installPushGuard({
  repoPath,
  cliPath,
  statePath,
  nodePath = process.execPath,
}) {
  const configuredPath = await unconfiguredGit(repoPath, ["rev-parse", "--git-path", "hooks/pre-push"]);
  const existingHookPath = resolve(repoPath, configuredPath);
  let existing = "";
  try {
    existing = await readFile(existingHookPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (existing.includes(MANAGED_MARKER)) {
    const originalLine = /^# Revisor original pre-push: (.+)$/m.exec(existing);
    let originalHookPath = null;
    if (originalLine) {
      try {
        originalHookPath = JSON.parse(originalLine[1]);
      } catch {
        throw new Error(`Managed pre-push hook metadata is invalid: ${existingHookPath}`);
      }
    }
    return writeManagedHook({
      hookPath: existingHookPath,
      originalHookPath,
      cliPath,
      statePath,
      repoPath,
      nodePath,
    });
  }
  const commonDirectory = resolve(repoPath, await git(repoPath, ["rev-parse", "--git-common-dir"]));
  const managedDirectory = resolve(commonDirectory, "revisor-hooks");
  const hookPath = resolve(managedDirectory, "pre-push");
  await mkdir(managedDirectory, { recursive: true });
  let sourceDirectory = dirname(existingHookPath);
  if (sourceDirectory.toLowerCase() === managedDirectory.toLowerCase()) {
    const globalPath = await unconfiguredGit(repoPath, ["config", "--global", "--get", "core.hooksPath"])
      .catch((error) => error.exitCode === 1 ? "" : Promise.reject(error));
    sourceDirectory = globalPath ? resolve(repoPath, globalPath) : null;
  }
  if (sourceDirectory && unsafeOriginalHookDirectory(sourceDirectory)) {
    throw new Error(`Refusing temporary or Concordia-injected original hooks directory: ${sourceDirectory}`);
  }
  if (existing && !sourceDirectory) {
    throw new Error(
      `A non-Revisor pre-push hook already exists and was not overwritten: ${
        existingHookPath
      }`,
    );
  }
  if (sourceDirectory && sourceDirectory.toLowerCase() !== managedDirectory.toLowerCase()) {
    let entries = [];
    try {
      entries = await readdir(sourceDirectory, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.name === "pre-push") continue;
      const originalPath = resolve(sourceDirectory, entry.name);
      try { await access(originalPath, constants.X_OK); } catch { continue; }
      const proxyPath = resolve(managedDirectory, entry.name);
      await writeFile(proxyPath, [
        "#!/bin/sh",
        `if [ -x ${shellQuote(originalPath)} ]; then exec ${shellQuote(originalPath)} "$@"; fi`,
        "",
      ].join("\n"), { encoding: "utf8", mode: 0o755 });
      await chmod(proxyPath, 0o755);
    }
  }
  for (const entry of await readdir(managedDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.name === "pre-push" || entry.name.includes(".bak-")) continue;
    if (!sourceDirectory || !(await existingFile(resolve(sourceDirectory, entry.name)))) {
      await unlink(resolve(managedDirectory, entry.name));
    }
  }
  await writeManagedHook({
    hookPath,
    originalHookPath: sourceDirectory && await existingFile(resolve(sourceDirectory, "pre-push"))
      ? resolve(sourceDirectory, "pre-push") : null,
    cliPath,
    statePath,
    repoPath,
    nodePath,
  });
  await git(repoPath, ["config", "--local", "core.hooksPath", managedDirectory]);
  return hookPath;
}

async function writeManagedHook({
  hookPath,
  originalHookPath,
  cliPath,
  statePath,
  repoPath,
  nodePath,
}) {
  const revisorCommand = `${shellQuote(nodePath)} ${shellQuote(cliPath)} guard-push --repo ${
    shellQuote(repoPath)
  } --state ${shellQuote(statePath)} "$@"`;
  const script = originalHookPath
    ? [
        "#!/bin/sh",
        MANAGED_MARKER,
        `# Revisor original pre-push: ${JSON.stringify(originalHookPath)}`,
        'input="${TMPDIR:-/tmp}/revisor-pre-push-$$"',
        'trap \'rm -f "$input"\' EXIT HUP INT TERM',
        'cat > "$input" || exit 1',
        `${shellQuote(originalHookPath)} "$@" < "$input" || exit $?`,
        `${revisorCommand} < "$input"`,
        "exit $?",
        "",
      ].join("\n")
    : [
    "#!/bin/sh",
    MANAGED_MARKER,
        "# Revisor original pre-push: null",
        `exec ${revisorCommand}`,
    "",
  ].join("\n");
  await mkdir(dirname(hookPath), { recursive: true });
  await writeFile(hookPath, script, { encoding: "utf8", mode: 0o755 });
  await chmod(hookPath, 0o755);
  await access(hookPath);
  return hookPath;
}

function parsePushLines(input) {
  return input
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [localRef, localSha, remoteRef, remoteSha] = line.trim().split(/\s+/);
      return { localRef, localSha, remoteRef, remoteSha };
    })
    .filter((record) =>
      record.localRef && record.localSha && record.remoteRef && record.remoteSha);
}

async function forkPoint(repoPath, baseRef, localSha) {
  try {
    return await git(repoPath, ["merge-base", `refs/heads/${baseRef}`, localSha]);
  } catch {
    // base がまだ無い / 到達しない (孤立ブランチ) 場合は分岐点が無い。
    return null;
  }
}

async function pushDiff(repoPath, record, baseRef) {
  let range;
  if (ZERO_SHA.test(record.remoteSha)) {
    // 新規 ref には remote 側の比較対象が無い。 base からの分岐点まで遡って走査する。
    // 分岐点が無い孤立履歴は、到達可能な全コミットを走査する。
    const fork = baseRef ? await forkPoint(repoPath, baseRef, record.localSha) : null;
    range = fork ? `${fork}..${record.localSha}` : record.localSha;
  } else {
    range = `${record.remoteSha}..${record.localSha}`;
  }
  // A final-tree diff misses a secret added and later deleted in the same
  // branch. GitHub receives every commit in this range, so scan every patch.
  return git(repoPath, [
    "log",
    "--format=",
    "--patch",
    "--no-ext-diff",
    range,
    "--",
  ]);
}

export async function guardMainPush({
  repoPath,
  statePath,
  input,
  now = () => new Date().toISOString(),
  authorizedPublication = process.env.REVISOR_PUBLISHING === "1",
  authorizedBranchPublication = process.env[BRANCH_PUSH_ENV_FLAG] === "1",
}) {
  // 配布済み hook は旧 revisor.state.json のパスを焼き込んでいる。 再インストール
  // なしで database を見つけられるよう、旧パスはここで読み替える。
  const store = new LocalPrStore({ path: redirectLegacyStorePath(statePath), now });
  const repository = store.findRepositoryByPath(repoPath);
  if (!repository) throw new Error(`Repository is not registered in Revisor: ${repoPath}`);
  const pushes = parsePushLines(input);
  const branchPushes = pushes.filter((record) =>
    record.remoteRef.startsWith("refs/heads/")
    && record.remoteRef !== `refs/heads/${repository.baseRef}`
    && !ZERO_SHA.test(record.localSha));
  // 作業ブランチは既定では出さない。 通れるのは Revisor 自身のブランチ送出
  // (`branch-push.mjs`) が旗を立てた子プロセスだけで、 直接の `git push` は
  // これまでどおり落ちる。 base とタグの認可はこの旗では動かない。
  const blockedRefs = authorizedBranchPublication
    ? []
    : branchPushes.map((record) => record.remoteRef);
  const checkedAt = now();
  if (blockedRefs.length > 0) {
    store.updatePushGuard(repository.repository, {
      status: "branch_push_blocked",
      checkedAt,
      blockedRefs,
      scannedAddedLines: 0,
      findings: [],
    });
    return {
      allowed: false,
      amendRequired: false,
      repository: repository.repository,
      blockedRefs,
      findings: [],
      scannedAddedLines: 0,
    };
  }
  const mainPushes = pushes.filter((record) =>
    record.remoteRef === `refs/heads/${repository.baseRef}`
    && !ZERO_SHA.test(record.localSha));
  const tagPushes = pushes.filter((record) => record.remoteRef.startsWith("refs/tags/"));
  if ((mainPushes.length > 0 || tagPushes.length > 0) && !authorizedPublication) {
    store.updatePushGuard(repository.repository, {
      status: "revisor_publication_required",
      checkedAt,
      scannedAddedLines: 0,
      findings: [],
    });
    return {
      allowed: false,
      amendRequired: false,
      publicationRequired: true,
      repository: repository.repository,
      findings: [],
      scannedAddedLines: 0,
    };
  }
  let scannedAddedLines = 0;
  const findings = [];
  // 認可されたブランチ送出も GitHub へ出る。 base と同じ漏洩走査を通す。
  for (const record of [...mainPushes, ...(authorizedBranchPublication ? branchPushes : [])]) {
    const result = scanAddedDiffForLeaks(await pushDiff(repoPath, record, repository.baseRef));
    scannedAddedLines += result.scannedAddedLines;
    findings.push(...result.findings);
  }
  if (findings.length > 0) {
    store.updatePushGuard(repository.repository, {
      status: "amend_required",
      checkedAt,
      scannedAddedLines,
      findings,
    });
    return {
      allowed: false,
      amendRequired: true,
      repository: repository.repository,
      findings,
      scannedAddedLines,
    };
  }
  store.updatePushGuard(repository.repository, {
    status: "safe",
    checkedAt,
    scannedAddedLines,
    findings: [],
  });
  return {
    allowed: true,
    amendRequired: false,
    repository: repository.repository,
    findings: [],
    scannedAddedLines,
  };
}
