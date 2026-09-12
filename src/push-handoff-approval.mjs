// @implements spec/feature/approved-push-handoff.md — Cc owns human approval
import { resolveServiceLoopbackUrl } from "./catalog.mjs";
import { readApprovalJson } from "./push-handoff-http.mjs";

export function approvalEndpoint(cwd, sessionId) {
  if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(sessionId)) {
    throw new Error("A Cc session ID is required for the handoff");
  }
  return `${resolveServiceLoopbackUrl(cwd, "concordia")}/v1/sessions/${encodeURIComponent(sessionId)}`;
}

export async function requestHandoffApproval({ endpoint, handoff, remoteUrl, read = readApprovalJson }) {
  const result = await read(`${endpoint}/push-check`, {
    cwd: handoff.cwd,
    push: { remoteName: "origin", remoteUrl, updates: handoff.updates.map((u) => ({
      localRef: u.newSha, localSha: u.newSha, remoteRef: u.ref, remoteSha: u.oldSha,
    })) },
  });
  // Do not accept ordinary GitHub-workflow permission as human approval.
  if (result.allowed !== true || result.reason !== "WARNING approved for this push only; existing Git hooks still apply") {
    throw new Error("Cc did not approve this exact WARNING operation");
  }
  return { reason: result.reason };
}

export async function verifyHandoffSession({ endpoint, handoff, branch, remoteUrl, read = readApprovalJson }) {
  const result = await read(endpoint, undefined, 15000);
  const s = result.session;
  const norm = (p) => String(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  if (!s || s.status !== "active" || norm(s.repo_path) !== norm(handoff.cwd)
    || s.branch !== branch || norm(s.repo_origin) !== norm(remoteUrl)) {
    throw new Error("Cc session binding changed; refusing handoff publication");
  }
}
