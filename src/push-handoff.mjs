// @implements spec/feature/approved-push-handoff.md — one approved remote publication attempt
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { githubRemoteUrl, runAuthenticatedGit } from "./authenticated-git.mjs";
import { resolveRegisteredRepository } from "./branch-push.mjs";
import { resolveGitHubAccess } from "./github-reachability.mjs";
import { resolveRepositoryWorkflow } from "./repository-workflow.mjs";
import { compareRemoteRefs, handoffDigest, handoffPushArgs, parsePushHandoff } from "./push-handoff-contract.mjs";
import { approvalEndpoint, requestHandoffApproval, verifyHandoffSession } from "./push-handoff-approval.mjs";
import { git } from "./workspace.mjs";

function summary(row) {
  return { id: row.id, repository: row.document.repository, status: row.status,
    detail: row.detail, updatedAt: row.updated_at };
}

async function verifyLocal(handoff, repository, runGit) {
  const origin = await runGit(handoff.cwd, ["remote", "get-url", "origin"]);
  if (origin !== githubRemoteUrl(repository.repository)) {
    throw new Error("Handoff requires the registered canonical HTTPS origin");
  }
  for (const u of handoff.updates) {
    await runGit(handoff.cwd, ["check-ref-format", u.ref]);
    const type = await runGit(handoff.cwd, ["cat-file", "-t", u.newSha]);
    if (u.ref.startsWith("refs/heads/") ? type !== "commit" : !["commit", "tag"].includes(type)) {
      throw new Error("Handoff target is not a branch commit or release tag");
    }
    if (type === "tag") {
      const tag = await runGit(handoff.cwd, ["cat-file", "-p", u.newSha]);
      if (tag.match(/^tag (.+)$/m)?.[1] !== u.ref.slice("refs/tags/".length)) {
        throw new Error("Annotated tag name differs from destination");
      }
    }
  }
  return { origin, branch: await runGit(handoff.cwd, ["branch", "--show-current"]) };
}

export async function publishPushHandoff(input, {
  sessionId, store, ledger, coordinator, reconcile = false, env = process.env,
  now = () => Date.now(), runGit = git, remoteGit = runAuthenticatedGit,
  resolveAccess = resolveGitHubAccess, requestApproval = requestHandoffApproval,
  verifySession = verifyHandoffSession, endpointFor = approvalEndpoint,
  realPath = realpath,
} = {}) {
  const handoff = parsePushHandoff(input);
  const endpoint = endpointFor(handoff.cwd, sessionId);
  const digest = handoffDigest(handoff, sessionId);
  const iso = () => new Date(now()).toISOString();
  const existing = ledger.find(handoff.id);
  if (existing && existing.digest !== digest) throw new Error("Handoff ID already belongs to different content or session");
  if (existing && !reconcile) return summary(existing);
  if (!existing && reconcile) throw new Error("No recorded handoff to reconcile");
  const repository = await resolveRegisteredRepository({ cwd: handoff.cwd, store, run: runGit });
  if (repository.repository !== handoff.repository || resolveRepositoryWorkflow(repository, env) !== "revisor") {
    throw new Error("Handoff requires a matching registered Revisor repository");
  }
  // A registered worktree must share the body's real object database, not just a look-alike path.
  const common = await runGit(handoff.cwd, ["rev-parse", "--git-common-dir"]);
  const bodyCommon = await runGit(repository.rootPath, ["rev-parse", "--git-common-dir"]);
  if (await realPath(resolve(handoff.cwd, common)) !== await realPath(resolve(repository.rootPath, bodyCommon))) {
    throw new Error("Handoff source does not share the registered object database");
  }
  const remoteUrl = githubRemoteUrl(repository.repository);
  const remote = async (access, args) => remoteGit({ cwd: repository.rootPath, args,
    token: access.token, env, authorizedPublication: true });
  const observe = (access) => remote(access, ["ls-remote", "--refs", remoteUrl, ...handoff.updates.map((u) => u.ref)]);
  const accessFor = async () => {
    const access = await resolveAccess({ repository, env });
    if (!access.reachable) throw new Error(access.reason);
    return access;
  };
  if (reconcile) {
    return coordinator.run(async () => {
      // A concurrent invocation may have completed while this command waited for the lock.
      const row = ledger.find(handoff.id);
      if (!["attempting", "unknown"].includes(row.status)) return summary(row);
      const refs = await observe(await accessFor());
      const matched = compareRemoteRefs(refs, handoff.updates, "newSha");
      ledger.transition(handoff.id, row.status, matched ? "published" : "unknown", {
        ...row.detail, reconciliation: matched ? "all desired refs observed" : "refs differ; no automatic retry",
        remoteRefs: refs, localSynchronizationRequired: matched,
      }, iso());
      return summary(ledger.find(handoff.id));
    });
  }
  const local = await verifyLocal(handoff, repository, runGit);
  await verifySession({ endpoint, handoff, branch: local.branch, remoteUrl });
  if (!ledger.create(handoff, sessionId, digest, iso())) {
    const row = ledger.find(handoff.id);
    if (row.digest !== digest) throw new Error("Handoff ID content raced with another caller");
    return summary(row);
  }
  let state = "awaiting_approval";
  let approval;
  try {
    approval = await requestApproval({ endpoint, handoff, remoteUrl });
    const approvedAt = now();
    ledger.transition(handoff.id, state, "approved", { approval, approvedAt, sessionId }, iso());
    state = "approved";
    return await coordinator.run(async () => {
      const current = store.findRepositoryByPath(repository.rootPath);
      if (!current || current.repository !== repository.repository || current.baseRef !== repository.baseRef
        || resolveRepositoryWorkflow(current, env) !== "revisor") throw new Error("Repository registration changed");
      const checkout = await verifyLocal(handoff, repository, runGit);
      if (checkout.branch !== local.branch) throw new Error("Checkout changed during approval");
      await verifySession({ endpoint, handoff, branch: local.branch, remoteUrl });
      const access = await accessFor();
      if (!compareRemoteRefs(await observe(access), handoff.updates, "oldSha")) {
        throw new Error("Remote refs differ from the approved expected SHAs; obtain fresh approval");
      }
      if (now() - approvedAt > 120000) throw new Error("Handoff approval expired before publication");
      ledger.transition(handoff.id, state, "attempting", { approval, approvedAt, sessionId }, iso());
      state = "attempting";
      await remote(access, handoffPushArgs(handoff, remoteUrl));
      if (!compareRemoteRefs(await observe(access), handoff.updates, "newSha")) {
        throw new Error("Push returned but desired remote refs could not be confirmed");
      }
      ledger.transition(handoff.id, state, "published", {
        approval, approvedAt, sessionId, localSynchronizationRequired: true,
      }, iso());
      state = "published";
      return summary(ledger.find(handoff.id));
    });
  } catch (error) {
    // Do not persist transport stderr: an upstream error might contain credential material.
    if (state !== "published") ledger.transition(handoff.id, state, state === "attempting" ? "unknown" : "rejected",
      { phase: state, reason: state === "attempting" ? "Publication outcome requires read-only reconciliation" : "Approval or preflight failed" }, iso());
    throw error;
  }
}
