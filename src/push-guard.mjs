import {
  access,
  chmod,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { scanAddedDiffForLeaks } from "./leakage.mjs";
import { LocalPrStore, redirectLegacyStorePath } from "./state-store.mjs";
import { git } from "./workspace.mjs";

const MANAGED_MARKER = "# LUDIARS Revisor managed pre-push hook";
const ZERO_SHA = /^0+$/;

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

export async function installPushGuard({
  repoPath,
  cliPath,
  statePath,
  nodePath = process.execPath,
}) {
  const configuredPath = await git(repoPath, ["rev-parse", "--git-path", "hooks/pre-push"]);
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
  const commonDirectory = resolve(
    repoPath,
    await git(repoPath, ["rev-parse", "--git-common-dir"]),
  );
  const managedDirectory = resolve(commonDirectory, "revisor-hooks");
  const hookPath = resolve(managedDirectory, "pre-push");
  await mkdir(managedDirectory, { recursive: true });
  const sourceDirectory = dirname(existingHookPath);
  if (
    existing
    && sourceDirectory.toLowerCase() === managedDirectory.toLowerCase()
  ) {
    throw new Error(
      `A non-Revisor pre-push hook already exists and was not overwritten: ${
        existingHookPath
      }`,
    );
  }
  if (sourceDirectory.toLowerCase() !== managedDirectory.toLowerCase()) {
    let entries = [];
    try {
      entries = await readdir(sourceDirectory, { withFileTypes: true });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || entry.name === "pre-push") continue;
      const proxyPath = resolve(managedDirectory, entry.name);
      await writeFile(proxyPath, [
        "#!/bin/sh",
        `exec ${shellQuote(resolve(sourceDirectory, entry.name))} "$@"`,
        "",
      ].join("\n"), { encoding: "utf8", mode: 0o755 });
      await chmod(proxyPath, 0o755);
    }
  }
  await writeManagedHook({
    hookPath,
    originalHookPath: existing ? existingHookPath : null,
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

async function pushDiff(repoPath, record) {
  if (ZERO_SHA.test(record.remoteSha)) {
    return git(repoPath, [
      "show",
      "--format=",
      "--no-ext-diff",
      record.localSha,
      "--",
    ]);
  }
  return git(repoPath, [
    "diff",
    "--no-ext-diff",
    record.remoteSha,
    record.localSha,
    "--",
  ]);
}

export async function guardMainPush({
  repoPath,
  statePath,
  input,
  now = () => new Date().toISOString(),
  authorizedPublication = process.env.REVISOR_PUBLISHING === "1",
}) {
  // 配布済み hook は旧 revisor.state.json のパスを焼き込んでいる。 再インストール
  // なしで database を見つけられるよう、旧パスはここで読み替える。
  const store = new LocalPrStore({ path: redirectLegacyStorePath(statePath), now });
  const repository = store.findRepositoryByPath(repoPath);
  if (!repository) throw new Error(`Repository is not registered in Revisor: ${repoPath}`);
  const pushes = parsePushLines(input);
  const blockedRefs = pushes
    .filter((record) =>
      record.remoteRef.startsWith("refs/heads/")
      && record.remoteRef !== `refs/heads/${repository.baseRef}`
      && !ZERO_SHA.test(record.localSha))
    .map((record) => record.remoteRef);
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
  for (const record of mainPushes) {
    const result = scanAddedDiffForLeaks(await pushDiff(repoPath, record));
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
