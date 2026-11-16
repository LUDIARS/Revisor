import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { outgoingRangeArgs, scanCommitMessageLog, scanOutgoingHistory } from "../src/outgoing-history.mjs";
import { guardPushDestinations, resolveDestinationRemotes } from "../src/push-destination.mjs";

test("commit messages preserve body line locations and never return values", () => {
  const sha = "a".repeat(40);
  const secret = "gh" + "p_" + "abcdefghijklmnopqrstuvwxyz123456";
  const findings = scanCommitMessageLog(`${sha}\nsafe subject\n\n${secret}\n\0`);
  assert.deepEqual(findings, [{ rule: "github-token", path: `commit/${sha}/message`, line: 3 }]);
  assert.ok(!JSON.stringify(findings).includes(secret));
});

test("invalid message records fail closed without including their contents", () => {
  const secret = "gh" + "p_" + "abcdefghijklmnopqrstuvwxyz123456";
  assert.throws(() => scanCommitMessageLog(secret + "\nbody\0"), error => !error.message.includes(secret));
  assert.deepEqual(scanCommitMessageLog(""), []);
});

test("commit messages enforce confidential terms while respecting repository exceptions", () => {
  const sha = "b".repeat(40);
  const value = "confidential-" + "fixture-name";
  const confidentialPolicy = {
    terms: [{ id: "term:fixture", value }],
    enforcement: { mode: "enforce-except", exceptRepositories: ["ludiars/private-fixture"] },
    categories: {}, workspaceRoots: [],
  };
  const log = `${sha}\nsafe subject\n\n${value}\n\0`;
  const findings = scanCommitMessageLog(log, { confidentialPolicy, repository: "LUDIARS/Product" });
  assert.deepEqual(findings, [{ rule: "confidential-term", termId: "term:fixture", path: `commit/${sha}/message`, line: 3 }]);
  assert.ok(!JSON.stringify(findings).includes(value));
  assert.deepEqual(scanCommitMessageLog(log, { confidentialPolicy, repository: "LUDIARS/private-fixture" }), []);
});

test("commit messages respect enforced, advisory and off host categories", () => {
  const sha = "c".repeat(40);
  const log = `${sha}\nsafe subject\n\n${"10." + "20.30.40"}\n\0`;
  for (const mode of ["advisory", "off", "enforce"]) {
    const confidentialPolicy = {
      terms: [], enforcement: { mode: "advisory", exceptRepositories: [] },
      categories: { "private-ip": mode }, workspaceRoots: [],
    };
    const findings = scanCommitMessageLog(log, { confidentialPolicy, repository: "LUDIARS/Product" });
    assert.equal(findings.length, mode === "enforce" ? 1 : 0);
    if (mode === "enforce") assert.equal(findings[0].kind, "private-ip");
  }
});

const ZERO = "0".repeat(40);

function fixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "revisor-outgoing-"));
  const run = (...args) => execFileSync("git", ["-c", "core.hooksPath=", ...args], {
    cwd: root, encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  }).trim();
  run("init", "-q", "-b", "main");
  const commit = (message) => {
    run("commit", "-q", "--allow-empty", "-m", message);
    return run("rev-parse", "HEAD");
  };
  return { root, run, commit, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const LEAK = "gh" + "p_" + "abcdefghijklmnopqrstuvwxyz123456";

test("existing ref updates keep the remoteSha..localSha range", () => {
  const record = { localSha: "a".repeat(40), remoteSha: "b".repeat(40) };
  assert.deepEqual(outgoingRangeArgs(record, ["origin"]), [`${"b".repeat(40)}..${"a".repeat(40)}`]);
});

test("new refs exclude destination remote-tracking history, else scan everything", () => {
  const record = { localSha: "a".repeat(40), remoteSha: ZERO };
  assert.deepEqual(outgoingRangeArgs(record, []), ["a".repeat(40)]);
  assert.deepEqual(outgoingRangeArgs(record, ["origin"]), ["a".repeat(40), "--not", "--remotes=origin"]);
});

test("a new tag on already-published history passes; unpublished leaks still block", async () => {
  const repo = fixtureRepo();
  try {
    const published = repo.commit(`published subject\n\n${LEAK}\n`);
    repo.run("remote", "add", "origin", "https://github.com/LUDIARS/Fixture.git");
    repo.run("update-ref", "refs/remotes/origin/main", published);
    // Revisor publication pushes to the URL, so pre-push receives it as both arguments.
    const destination = "https://x-access-token@github.com/ludiars/fixture";
    const remotes = await resolveDestinationRemotes(repo.root, [destination, destination]);
    assert.deepEqual(remotes, ["origin"]);

    const publishedTag = { localSha: published, remoteSha: ZERO };
    const clean = await scanOutgoingHistory(repo.root, publishedTag, { env: {}, remotes });
    assert.equal(clean.totalFindings, 0);

    // Without a resolved destination the whole ancestry is scanned, as before.
    const unresolved = await resolveDestinationRemotes(repo.root, ["https://github.com/LUDIARS/Other.git"]);
    assert.deepEqual(unresolved, []);
    const full = await scanOutgoingHistory(repo.root, publishedTag, { env: {}, remotes: unresolved });
    assert.deepEqual(full.findings.map(finding => finding.path), [`commit/${published}/message`]);

    const unpublished = repo.commit(`unpublished subject\n\n${LEAK}\n`);
    const newTag = await scanOutgoingHistory(repo.root, { localSha: unpublished, remoteSha: ZERO }, { env: {}, remotes });
    assert.deepEqual(newTag.findings.map(finding => finding.path), [`commit/${unpublished}/message`]);
    assert.ok(!JSON.stringify(newTag).includes(LEAK));
  } finally {
    repo.cleanup();
  }
});

test("remote names and equivalent URL spellings resolve; anything else stays unresolved", async () => {
  const repo = fixtureRepo();
  try {
    repo.run("remote", "add", "origin", "git@github.com:LUDIARS/Fixture.git");
    repo.run("remote", "add", "mirror", "https://example.invalid/mirror.git");
    assert.deepEqual(await resolveDestinationRemotes(repo.root, ["origin", "git@github.com:LUDIARS/Fixture.git"]), ["origin"]);
    assert.deepEqual(await resolveDestinationRemotes(repo.root, ["https://github.com/ludiars/fixture/"]), ["origin"]);
    assert.deepEqual(await resolveDestinationRemotes(repo.root, ["--remotes=*"]), []);
    assert.deepEqual(await resolveDestinationRemotes(repo.root, []), []);
    assert.deepEqual(await resolveDestinationRemotes(join(repo.root, "missing"), ["origin"]), []);
  } finally {
    repo.cleanup();
  }
});

test("guard-push destinations are the hook positionals after --repo/--state", () => {
  assert.deepEqual(
    guardPushDestinations(["guard-push", "--repo", "/r", "--state", "/s", "origin", "https://github.com/a/b.git"]),
    ["origin", "https://github.com/a/b.git"],
  );
  assert.deepEqual(guardPushDestinations(["guard-push", "--repo", "/r", "--state", "/s"]), []);
});
