import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { guardMainPush, installPushGuard } from "../src/push-guard.mjs";
import { LocalPrStore } from "../src/state-store.mjs";

function git(repoPath, ...args) {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "revisor-push-guard-"));
  const repoPath = join(directory, "Product");
  const init = spawnSync("git", ["init", repoPath], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (init.status !== 0) throw new Error(init.stderr || init.stdout);
  git(repoPath, "checkout", "-b", "main");
  git(repoPath, "config", "user.name", "Test");
  git(repoPath, "config", "user.email", "test@example.invalid");
  writeFileSync(join(repoPath, "safe.txt"), "safe\n", "utf8");
  git(repoPath, "add", "safe.txt");
  git(repoPath, "commit", "-m", "base");
  return { directory, repoPath, baseSha: git(repoPath, "rev-parse", "HEAD") };
}

test("scans a detached commit refspec, blocks leakage, then accepts the amended commit", async () => {
  const state = fixture();
  const statePath = join(state.directory, "state.json");
  const store = new LocalPrStore({ path: statePath });
  store.registerRepository({
    repository: "LUDIARS/Product",
    rootPath: state.repoPath,
    baseRef: "main",
    testCases: [{ name: "unit" }],
  });
  try {
    writeFileSync(
      join(state.repoPath, "config.js"),
      `const token = "${"gh" + "p_"}abcdefghijklmnopqrstuvwxyz123456";\n`,
      "utf8",
    );
    git(state.repoPath, "add", "config.js");
    git(state.repoPath, "commit", "-m", "unsafe");
    const unsafeSha = git(state.repoPath, "rev-parse", "HEAD");
    const unsafe = await guardMainPush({
      repoPath: state.repoPath,
      statePath,
      input: `${unsafeSha} ${unsafeSha} refs/heads/main ${state.baseSha}\n`,
      authorizedPublication: true,
    });
    assert.equal(unsafe.allowed, false);
    assert.equal(unsafe.amendRequired, true);
    assert.equal(store.getRepository("LUDIARS/Product").pushGuard.status, "amend_required");

    writeFileSync(join(state.repoPath, "config.js"), "const token = process.env.TOKEN;\n", "utf8");
    git(state.repoPath, "add", "config.js");
    git(state.repoPath, "commit", "--amend", "--no-edit");
    const amendedSha = git(state.repoPath, "rev-parse", "HEAD");
    const safe = await guardMainPush({
      repoPath: state.repoPath,
      statePath,
      input: `${amendedSha} ${amendedSha} refs/heads/main ${state.baseSha}\n`,
      authorizedPublication: true,
    });
    assert.equal(safe.allowed, true);
    assert.equal(store.getRepository("LUDIARS/Product").pushGuard.status, "safe");
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test("blocks every non-main branch update before it reaches a remote", async () => {
  const state = fixture();
  const statePath = join(state.directory, "state.json");
  const store = new LocalPrStore({ path: statePath });
  store.registerRepository({
    repository: "LUDIARS/Product",
    rootPath: state.repoPath,
    baseRef: "main",
    testCases: [{ name: "unit" }],
  });
  try {
    const result = await guardMainPush({
      repoPath: state.repoPath,
      statePath,
      input: `refs/heads/feat/private ${state.baseSha} refs/heads/feat/private ${
        "0".repeat(40)
      }\n`,
    });
    assert.equal(result.allowed, false);
    assert.equal(result.amendRequired, false);
    assert.deepEqual(result.blockedRefs, ["refs/heads/feat/private"]);
    assert.equal(
      store.getRepository("LUDIARS/Product").pushGuard.status,
      "branch_push_blocked",
    );
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test("blocks a direct release-tag push outside Revisor publication", async () => {
  const state = fixture();
  const statePath = join(state.directory, "state.json");
  const store = new LocalPrStore({ path: statePath });
  store.registerRepository({
    repository: "LUDIARS/Product",
    rootPath: state.repoPath,
    baseRef: "main",
    testCases: [{ name: "unit" }],
  });
  try {
    const result = await guardMainPush({
      repoPath: state.repoPath,
      statePath,
      input: `refs/tags/v0.1.0 ${state.baseSha} refs/tags/v0.1.0 ${"0".repeat(40)}\n`,
    });
    assert.equal(result.allowed, false);
    assert.equal(result.publicationRequired, true);
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test("installs a managed pre-push hook without overwriting an existing hook", async () => {
  const state = fixture();
  try {
    const hookPath = await installPushGuard({
      repoPath: state.repoPath,
      cliPath: "E:/Document/Ars/Revisor/src/cli.mjs",
      statePath: join(state.directory, "state.json"),
      nodePath: "C:/Program Files/nodejs/node.exe",
    });
    assert.match(readFileSync(hookPath, "utf8"), /LUDIARS Revisor managed pre-push hook/);
    assert.equal(await installPushGuard({
      repoPath: state.repoPath,
      cliPath: "E:/Document/Ars/Revisor/src/cli.mjs",
      statePath: join(state.directory, "state.json"),
      nodePath: "C:/Program Files/nodejs/node.exe",
    }), hookPath);
    writeFileSync(hookPath, "#!/bin/sh\necho custom\n", "utf8");
    await assert.rejects(() => installPushGuard({
      repoPath: state.repoPath,
      cliPath: "cli.mjs",
      statePath: "state.json",
    }), /was not overwritten/);
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test("認可されたブランチ送出は通し、base の認可までは広げない", async () => {
  const state = fixture();
  const statePath = join(state.directory, "state.json");
  const store = new LocalPrStore({ path: statePath });
  store.registerRepository({
    repository: "LUDIARS/Product",
    rootPath: state.repoPath,
    baseRef: "main",
    testCases: [{ name: "unit" }],
  });
  try {
    git(state.repoPath, "checkout", "-b", "feat/thing");
    writeFileSync(join(state.repoPath, "feature.txt"), "safe feature\n", "utf8");
    git(state.repoPath, "add", "feature.txt");
    git(state.repoPath, "commit", "-m", "feature");
    const headSha = git(state.repoPath, "rev-parse", "HEAD");

    const branch = await guardMainPush({
      repoPath: state.repoPath,
      statePath,
      input: `refs/heads/feat/thing ${headSha} refs/heads/feat/thing ${"0".repeat(40)}\n`,
      authorizedBranchPublication: true,
    });
    assert.equal(branch.allowed, true);
    assert.deepEqual(branch.blockedRefs ?? [], []);
    assert.ok(branch.scannedAddedLines > 0);

    // ブランチ送出の認可は base 送出の認可ではない。
    const base = await guardMainPush({
      repoPath: state.repoPath,
      statePath,
      input: `${headSha} ${headSha} refs/heads/main ${state.baseSha}\n`,
      authorizedBranchPublication: true,
    });
    assert.equal(base.allowed, false);
    assert.equal(base.publicationRequired, true);
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test("新規ブランチは tip だけでなく分岐点まで遡って漏洩を見る", async () => {
  const state = fixture();
  const statePath = join(state.directory, "state.json");
  const store = new LocalPrStore({ path: statePath });
  store.registerRepository({
    repository: "LUDIARS/Product",
    rootPath: state.repoPath,
    baseRef: "main",
    testCases: [{ name: "unit" }],
  });
  try {
    git(state.repoPath, "checkout", "-b", "feat/leaky");
    // 秘密は途中のコミットで入り、 tip では別ファイルしか触らない。
    writeFileSync(
      join(state.repoPath, "config.js"),
      `const token = "${"gh" + "p_"}abcdefghijklmnopqrstuvwxyz123456";\n`,
      "utf8",
    );
    git(state.repoPath, "add", "config.js");
    git(state.repoPath, "commit", "-m", "unsafe middle");
    writeFileSync(join(state.repoPath, "readme.txt"), "docs\n", "utf8");
    git(state.repoPath, "add", "readme.txt");
    git(state.repoPath, "commit", "-m", "safe tip");
    const headSha = git(state.repoPath, "rev-parse", "HEAD");

    const result = await guardMainPush({
      repoPath: state.repoPath,
      statePath,
      input: `refs/heads/feat/leaky ${headSha} refs/heads/feat/leaky ${"0".repeat(40)}\n`,
      authorizedBranchPublication: true,
    });
    assert.equal(result.allowed, false);
    assert.equal(result.amendRequired, true);
    assert.ok(result.findings.length > 0);
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});

test("途中で削除された秘密も送出履歴に残るため拒む", async () => {
  const state = fixture();
  const statePath = join(state.directory, "state.json");
  const store = new LocalPrStore({ path: statePath });
  store.registerRepository({
    repository: "LUDIARS/Product",
    rootPath: state.repoPath,
    baseRef: "main",
    testCases: [{ name: "unit" }],
  });
  try {
    git(state.repoPath, "checkout", "-b", "feat/removed-secret");
    writeFileSync(
      join(state.repoPath, "config.js"),
      `const token = "${"gh" + "p_"}abcdefghijklmnopqrstuvwxyz123456";\n`,
      "utf8",
    );
    git(state.repoPath, "add", "config.js");
    git(state.repoPath, "commit", "-m", "unsafe middle");
    writeFileSync(join(state.repoPath, "config.js"), "const token = process.env.TOKEN;\n", "utf8");
    git(state.repoPath, "add", "config.js");
    git(state.repoPath, "commit", "-m", "remove secret");
    const headSha = git(state.repoPath, "rev-parse", "HEAD");

    const result = await guardMainPush({
      repoPath: state.repoPath,
      statePath,
      input: `refs/heads/feat/removed-secret ${headSha} refs/heads/feat/removed-secret ${"0".repeat(40)}\n`,
      authorizedBranchPublication: true,
    });
    assert.equal(result.allowed, false);
    assert.equal(result.amendRequired, true);
    assert.ok(result.findings.length > 0);
  } finally {
    rmSync(state.directory, { recursive: true, force: true });
  }
});
