import assert from "node:assert/strict";
import test from "node:test";
import {
  BRANCH_PUSH_ENV_FLAG,
  pushBranch,
  resolveRegisteredRepository,
} from "../src/branch-push.mjs";

const REPOSITORY = {
  repository: "LUDIARS/Product",
  rootPath: "E:/Document/Ars/Product",
  baseRef: "main",
};

function storeFor(paths) {
  const registered = new Set(paths.map((path) => path.toLowerCase()));
  return {
    findRepositoryByPath(path) {
      return registered.has(String(path).split("\\").join("/").toLowerCase())
        ? REPOSITORY
        : null;
    },
  };
}

function runner({ commonDirectory = ".git", head = "feat/thing", sha = "a".repeat(40) } = {}) {
  const calls = [];
  return {
    calls,
    async run(cwd, args) {
      calls.push({ cwd, args });
      if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return commonDirectory;
      if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return head;
      if (args[0] === "rev-parse") return sha;
      throw new Error(`unexpected git ${args.join(" ")}`);
    },
  };
}

function recorder() {
  const events = [];
  return { events, log: (event, detail) => events.push({ event, detail }) };
}

test("worktree の path からでも登録リポジトリへ辿り着く", async () => {
  const store = storeFor([REPOSITORY.rootPath]);
  // linked worktree では `--git-common-dir` が本体 checkout の .git を指す。
  const git = runner({ commonDirectory: "E:/Document/Ars/Product/.git" });
  const resolved = await resolveRegisteredRepository({
    cwd: "E:/Document/Ars/.worktrees/Product-task",
    store,
    run: git.run,
  });
  assert.equal(resolved.repository, "LUDIARS/Product");
});

test("未登録リポジトリは送出しない", async () => {
  await assert.rejects(
    resolveRegisteredRepository({
      cwd: "E:/Document/Ars/Unknown",
      store: storeFor([]),
      run: runner().run,
    }),
    /not registered in Revisor/,
  );
});

test("App 認証で送り、認可の旗を子プロセスへ渡す", async () => {
  const pushes = [];
  const log = recorder();
  const result = await pushBranch({
    cwd: REPOSITORY.rootPath,
    store: storeFor([REPOSITORY.rootPath]),
    run: runner().run,
    env: { REVISOR_PUBLISHING: "1", ALLOW_MAIN_PUSH: "1" },
    log: log.log,
    resolveAccess: async () => ({ reachable: true, token: "installation-token" }),
    pushAuthenticated: async (request) => pushes.push(request),
  });
  assert.equal(result.pushed, true);
  assert.equal(result.remoteBranch, "feat/thing");
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].refspec, "refs/heads/feat/thing:refs/heads/feat/thing");
  assert.equal(pushes[0].env[BRANCH_PUSH_ENV_FLAG], "1");
  assert.equal(pushes[0].env.REVISOR_PUBLISHING, undefined);
  assert.equal(pushes[0].env.ALLOW_MAIN_PUSH, undefined);
  assert.equal(pushes[0].authorizedPublication, false);
  assert.deepEqual(pushes[0].options, []);
  assert.deepEqual(log.events.map((entry) => entry.event), [
    "branch_push_started",
    "branch_push_completed",
  ]);
});

test("base への送出は publication の領分なので拒む", async () => {
  await assert.rejects(
    pushBranch({
      cwd: REPOSITORY.rootPath,
      branch: "main",
      store: storeFor([REPOSITORY.rootPath]),
      run: runner().run,
      env: {},
      log: () => {},
      resolveAccess: async () => ({ reachable: true, token: "t" }),
      pushAuthenticated: async () => {},
    }),
    /Merge the local PR through Revisor/,
  );
});

test("option へ化けるブランチ名は受け付けない", async () => {
  await assert.rejects(
    pushBranch({
      cwd: REPOSITORY.rootPath,
      branch: "--force",
      store: storeFor([REPOSITORY.rootPath]),
      run: runner().run,
      env: {},
      log: () => {},
    }),
    /is not a valid branch name/,
  );
});

test("Git が受け付けない ref の形は送出前に拒む", async () => {
  for (const branch of ["feature//thing", "feature/.private", "feature.lock/thing"]) {
    await assert.rejects(
      pushBranch({
        cwd: REPOSITORY.rootPath,
        branch,
        store: storeFor([REPOSITORY.rootPath]),
        run: runner().run,
        env: {},
        log: () => {},
      }),
      /is not a valid branch name/,
    );
  }
});

test("App 未インストールは保留にせず失敗として返す", async () => {
  const log = recorder();
  await assert.rejects(
    pushBranch({
      cwd: REPOSITORY.rootPath,
      store: storeFor([REPOSITORY.rootPath]),
      run: runner().run,
      env: {},
      log: log.log,
      resolveAccess: async () => ({ reachable: false, reason: "The GitHub App is not installed." }),
    }),
    /could not reach GitHub/,
  );
  assert.equal(log.events.at(-1).event, "branch_push_refused");
});

test("github workflow の org は App を組み立てず通常 push で送る", async () => {
  const plain = [];
  const result = await pushBranch({
    cwd: REPOSITORY.rootPath,
    remoteBranch: "review/thing",
    forceWithLease: true,
    actor: "neco",
    store: storeFor([REPOSITORY.rootPath]),
    run: runner().run,
    env: { REVISOR_ORG_WORKFLOWS: "LUDIARS=github" },
    log: () => {},
    resolveAccess: async () => {
      throw new Error("App credentials must not be read for the github workflow");
    },
    pushPlain: async (request) => plain.push(request),
  });
  assert.equal(result.workflow, "github");
  assert.equal(result.actor, "neco");
  assert.equal(plain[0].refspec, "refs/heads/feat/thing:refs/heads/review/thing");
  assert.deepEqual(plain[0].options, ["--force-with-lease"]);
});
